/**
 * Semantic vector storage (issue #39).
 *
 * Vectors live in a real vector table — LanceDB (`<data-dir>/semantic.lance`)
 * with a typed `FixedSizeList<Float32>` column and SQL predicates pushed down
 * at query time — instead of JSON text in SQLite. SQLite remains the source of
 * truth for messages/chunks/FTS; the Lance table is a rebuildable semantic
 * index (same contract as MinSync's `documents.lance`).
 *
 * The embedder identity is persisted next to the table
 * (`<data-dir>/semantic.identity.json`). A mismatch requires a full rebuild,
 * never silent reuse.
 */
import * as arrow from "apache-arrow";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { EmbedderIdentity, SearchFilters } from "./types.js";

export const SEMANTIC_TABLE = "semantic";
export const SEMANTIC_IDENTITY_FILE = "semantic.identity.json";
export const SEMANTIC_STORE_DIR = "semantic.lance";

/** A vector row as stored in the semantic table. */
export interface SemanticVectorDoc {
  chunkId: string;
  vector: number[];
  contentHash: string;
  accountId: string;
  mailbox: string;
  threadId: string;
  messageId: string;
  /** Message date (ISO string) so `after`/`before` filters can be pushed down. */
  date: string;
  /** Lowercased from address so `from` filters can be pushed down. */
  fromAddress: string;
}

export interface SemanticHit {
  chunkId: string;
  /** Cosine similarity in [0, 1] (Lance `_distance` converted). */
  score: number;
}

export interface SemanticStore {
  readonly kind: "lancedb" | "memory";
  readIdentity(): EmbedderIdentity | undefined;
  writeIdentity(identity: EmbedderIdentity): void;
  /** Creates the vector table when missing, with the given dimension. */
  ensureTable(dimension: number): Promise<void>;
  upsert(docs: SemanticVectorDoc[]): Promise<void>;
  query(vector: number[], filters: SearchFilters, limit: number): Promise<SemanticHit[]>;
  countRows(): Promise<number>;
  /** Stored content hash per chunk id (missing entries are unindexed or stale). */
  contentHashes(chunkIds: string[]): Promise<Map<string, string>>;
  listChunkIds(): Promise<string[]>;
  deleteChunkIds(chunkIds: string[]): Promise<void>;
  drop(): Promise<void>;
}

/**
 * Compares the identity fields that define the vector space. `runtimeBuild`
 * and `indexedRevision` are informational and deliberately excluded.
 */
export function sameEmbedder(left: EmbedderIdentity | undefined, right: EmbedderIdentity | undefined): boolean {
  if (!left || !right) return false;
  return left.provider === right.provider
    && left.model === right.model
    && left.dimension === right.dimension
    && (left.queryPrefix ?? "") === (right.queryPrefix ?? "")
    && (left.passagePrefix ?? "") === (right.passagePrefix ?? "");
}

/**
 * Translate search filters into a Lance SQL predicate over the vector table.
 * Only `to` cannot be pushed down (it lives in SQLite `json_each`); the caller
 * over-fetches and post-filters it during hydration.
 */
export function semanticFilterSql(filters: SearchFilters): string | undefined {
  const clauses: string[] = [];
  if (filters.accountId) clauses.push(`account_id = ${sqlString(filters.accountId)}`);
  if (filters.mailbox) clauses.push(`mailbox = ${sqlString(filters.mailbox)}`);
  if (filters.threadId) clauses.push(`thread_id = ${sqlString(filters.threadId)}`);
  if (filters.from) clauses.push(`from_address = ${sqlString(filters.from.toLocaleLowerCase())}`);
  if (filters.after) clauses.push(`date >= ${sqlString(filters.after)}`);
  if (filters.before) clauses.push(`date <= ${sqlString(filters.before)}`);
  return clauses.length ? clauses.join(" AND ") : undefined;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function validateDimension(dimension: number): void {
  if (!Number.isInteger(dimension) || dimension <= 0) throw new Error("semantic vector dimension must be a positive integer");
}

/** LanceDB-backed store. `open` creates the table; `openExisting` stays read-only when absent. */
export class LanceSemanticStore implements SemanticStore {
  readonly kind = "lancedb" as const;
  private table?: lancedb.Table;

  private constructor(
    private readonly db: lancedb.Connection,
    private readonly identityPath: string,
    private dimension: number,
  ) {}

  static async open(dataDir: string, dimension: number): Promise<LanceSemanticStore> {
    validateDimension(dimension);
    mkdirSync(dataDir, { recursive: true });
    const db = await lancedb.connect(dataDir);
    const store = new LanceSemanticStore(db, join(dataDir, SEMANTIC_IDENTITY_FILE), dimension);
    await store.ensureTable(dimension);
    return store;
  }

  /** Opens the store only when a semantic table already exists; never creates one. */
  static async openExisting(dataDir: string): Promise<LanceSemanticStore | undefined> {
    if (!existsSync(join(dataDir, SEMANTIC_STORE_DIR))) return undefined;
    const identityPath = join(dataDir, SEMANTIC_IDENTITY_FILE);
    const identity = existsSync(identityPath) ? readIdentityFile(identityPath) : undefined;
    return LanceSemanticStore.open(dataDir, identity?.dimension ?? 1).catch(() => undefined);
  }

  readIdentity(): EmbedderIdentity | undefined {
    if (!existsSync(this.identityPath)) return undefined;
    try {
      return JSON.parse(readFileSync(this.identityPath, "utf8")) as EmbedderIdentity;
    } catch {
      return undefined;
    }
  }

  writeIdentity(identity: EmbedderIdentity): void {
    writeFileSync(this.identityPath, `${JSON.stringify(identity, null, 2)}\n`);
  }

  async ensureTable(dimension: number): Promise<void> {
    validateDimension(dimension);
    this.dimension = dimension;
    if (!(await this.db.tableNames()).includes(SEMANTIC_TABLE)) {
      await this.db.createTable(SEMANTIC_TABLE, emptySchemaTable(dimension), { mode: "create" });
    }
    this.table ??= await this.db.openTable(SEMANTIC_TABLE);
  }

  async upsert(docs: SemanticVectorDoc[]): Promise<void> {
    if (!docs.length) return;
    for (const doc of docs) {
      if (!Array.isArray(doc.vector) || doc.vector.length !== this.dimension) {
        throw new Error(`semantic vector for ${doc.chunkId} has dimension ${doc.vector.length}, expected ${this.dimension}`);
      }
    }
    const rows = docs.map((doc) => ({
      chunk_id: doc.chunkId,
      vector: doc.vector.map((value) => Number(value)),
      content_hash: doc.contentHash,
      account_id: doc.accountId,
      mailbox: doc.mailbox,
      thread_id: doc.threadId,
      message_id: doc.messageId,
      date: doc.date,
      from_address: doc.fromAddress,
    }));
    await (await this.getTable())
      .mergeInsert("chunk_id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(rows);
  }

  async query(vector: number[], filters: SearchFilters, limit: number): Promise<SemanticHit[]> {
    if (vector.length !== this.dimension) throw new Error(`query vector has dimension ${vector.length}, expected ${this.dimension}`);
    const table = await this.getTable();
    if ((await table.countRows()) === 0) return [];
    // A vector argument always yields a VectorQuery at runtime; the declared
    // union includes the string/FTS overloads which lack `.distanceType`.
    const vectorQuery = table.search(vector.map((value) => Number(value))) as lancedb.VectorQuery;
    let search = vectorQuery.distanceType("cosine").limit(limit);
    const where = semanticFilterSql(filters);
    if (where) search = search.where(where);
    const rows = (await search.toArray()) as Array<Record<string, unknown>>;
    return rows
      .filter((row) => typeof row.chunk_id === "string")
      .map((row) => ({ chunkId: row.chunk_id as string, score: 1 - Number(row._distance ?? 1) }));
  }

  async countRows(): Promise<number> {
    return (await this.getTable()).countRows();
  }

  async contentHashes(chunkIds: string[]): Promise<Map<string, string>> {
    if (!chunkIds.length) return new Map();
    const rows = await (await this.getTable())
      .query()
      .where(`chunk_id IN (${chunkIds.map(sqlString).join(", ")})`)
      .select(["chunk_id", "content_hash"])
      .toArray() as Array<Record<string, unknown>>;
    return new Map(rows.map((row) => [row.chunk_id as string, row.content_hash as string]));
  }

  async listChunkIds(): Promise<string[]> {
    const rows = await (await this.getTable()).query().select(["chunk_id"]).toArray();
    return rows.map((row) => row.chunk_id as string).filter((value) => typeof value === "string");
  }

  async deleteChunkIds(chunkIds: string[]): Promise<void> {
    if (!chunkIds.length) return;
    await (await this.getTable()).delete(`chunk_id IN (${chunkIds.map(sqlString).join(", ")})`);
  }

  async drop(): Promise<void> {
    this.table = undefined;
    if ((await this.db.tableNames()).includes(SEMANTIC_TABLE)) await this.db.dropTable(SEMANTIC_TABLE);
    rmSync(this.identityPath, { force: true });
  }

  private async getTable(): Promise<lancedb.Table> {
    this.table ??= await this.db.openTable(SEMANTIC_TABLE);
    return this.table;
  }
}

function readIdentityFile(path: string): EmbedderIdentity | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as EmbedderIdentity;
  } catch {
    return undefined;
  }
}

function emptySchemaTable(dimension: number): arrow.Table {
  return new arrow.Table(new arrow.Schema([
    new arrow.Field("chunk_id", new arrow.Utf8(), true),
    new arrow.Field("vector", new arrow.FixedSizeList(dimension, new arrow.Field("item", new arrow.Float32(), true)), true),
    new arrow.Field("content_hash", new arrow.Utf8(), true),
    new arrow.Field("account_id", new arrow.Utf8(), true),
    new arrow.Field("mailbox", new arrow.Utf8(), true),
    new arrow.Field("thread_id", new arrow.Utf8(), true),
    new arrow.Field("message_id", new arrow.Utf8(), true),
    new arrow.Field("date", new arrow.Utf8(), true),
    new arrow.Field("from_address", new arrow.Utf8(), true),
  ]));
}

/**
 * In-process store for `:memory:` archives (and unit tests): same contract as
 * the Lance store, mirroring MinSync's memory vector store.
 */
export class MemorySemanticStore implements SemanticStore {
  readonly kind = "memory" as const;
  private readonly rows = new Map<string, SemanticVectorDoc>();
  private identity?: EmbedderIdentity;

  readIdentity(): EmbedderIdentity | undefined {
    return this.identity ? { ...this.identity } : undefined;
  }

  writeIdentity(identity: EmbedderIdentity): void {
    this.identity = { ...identity };
  }

  async ensureTable(): Promise<void> {
    // The memory store is untyped: rows define their own vector length.
  }

  async upsert(docs: SemanticVectorDoc[]): Promise<void> {
    for (const doc of docs) {
      if (!Array.isArray(doc.vector) || doc.vector.length === 0) throw new Error(`semantic vector for ${doc.chunkId} is empty`);
      this.rows.set(doc.chunkId, { ...doc, vector: [...doc.vector] });
    }
  }

  async query(vector: number[], filters: SearchFilters, limit: number): Promise<SemanticHit[]> {
    const predicate = semanticFilterSql(filters);
    const hits: SemanticHit[] = [];
    for (const doc of this.rows.values()) {
      if (predicate && !matchesPredicate(doc, filters)) continue;
      hits.push({ chunkId: doc.chunkId, score: dot(vector, doc.vector) });
    }
    return hits.sort((left, right) => right.score - left.score || left.chunkId.localeCompare(right.chunkId)).slice(0, limit);
  }

  async countRows(): Promise<number> {
    return this.rows.size;
  }

  async contentHashes(chunkIds: string[]): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();
    for (const chunkId of chunkIds) {
      const doc = this.rows.get(chunkId);
      if (doc) hashes.set(chunkId, doc.contentHash);
    }
    return hashes;
  }

  async listChunkIds(): Promise<string[]> {
    return [...this.rows.keys()];
  }

  async deleteChunkIds(chunkIds: string[]): Promise<void> {
    for (const chunkId of chunkIds) this.rows.delete(chunkId);
  }

  async drop(): Promise<void> {
    this.rows.clear();
    this.identity = undefined;
  }
}

function matchesPredicate(doc: SemanticVectorDoc, filters: SearchFilters): boolean {
  if (filters.accountId && doc.accountId !== filters.accountId) return false;
  if (filters.mailbox && doc.mailbox !== filters.mailbox) return false;
  if (filters.threadId && doc.threadId !== filters.threadId) return false;
  if (filters.from && doc.fromAddress !== filters.from.toLocaleLowerCase()) return false;
  if (filters.after && doc.date < filters.after) return false;
  if (filters.before && doc.date > filters.before) return false;
  return true;
}

function dot(left: number[], right: number[]): number {
  let sum = 0;
  for (let index = 0; index < left.length; index++) sum += left[index] * (right[index] ?? 0);
  return sum;
}
