import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ClassificationPolicy, Chunk, EmbedderConfig, EmbedderIdentity, MailMessage, NormalizedMessage, SearchFilters, SearchHit, SyncReport } from "./types.js";
import { buildChunks } from "./chunk.js";
import { normalizeMessage } from "./normalize.js";
import { scopedId, snippet } from "./util.js";
import { createEmbedder, embedderIdentity, embedderIdentityLabel, embeddingBatchSize, legacyEmbedderIdentity, LEGACY_EMBEDDING_MODEL, type Embedder } from "./embedding.js";
import { LanceSemanticStore, MemorySemanticStore, sameEmbedder, type SemanticStore } from "./semantic-store.js";
import { createLexicalAnalyzers, languagesForText, lexicalFields, LEXICAL_ANALYZER_VERSION, tokenizeForLanguage, type LexicalAnalyzers } from "./lexical.js";

export interface SemanticIndexReport {
  embedded: number;
  reused: number;
  archiveRevision: string;
  /** True when the vector table was discarded and rebuilt from scratch. */
  rebuilt: boolean;
}

export interface SemanticSummary {
  status: "missing" | "never-completed" | "interrupted" | "rebuild-required" | "corrupt" | "stale" | "healthy";
  provider?: string;
  model?: string;
  dimension?: number;
  vectorCount: number;
  embeddingBacklog: number;
  archiveRevision: string;
}

export class Archive {
  readonly db: Database.Database;
  private embedder?: Embedder;
  private lexical?: LexicalAnalyzers;
  private operationTail: Promise<void> = Promise.resolve();
  private lexicalRebuildRequired: boolean;
  private readonly embedderConfig?: EmbedderConfig;
  /** Directory holding `archive.sqlite` (and `semantic.lance`); undefined for `:memory:` archives. */
  private readonly dataDir?: string;
  private store?: SemanticStore;

  constructor(path = ":memory:", embedderConfig?: EmbedderConfig) {
    this.embedderConfig = embedderConfig;
    this.dataDir = path === ":memory:" ? undefined : dirname(path);
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    migrate(this.db);
    cleanupOrphanedSemanticRows(this.db);
    this.lexicalRebuildRequired = this.db.prepare("SELECT version FROM lexical_index_meta WHERE id = 1").get() === undefined;
    if (!this.lexicalRebuildRequired) {
      const row = this.db.prepare("SELECT version FROM lexical_index_meta WHERE id = 1").get() as { version: string };
      this.lexicalRebuildRequired = row.version !== LEXICAL_ANALYZER_VERSION;
    }
    if (this.lexicalRebuildRequired) {
      for (const language of lexicalFields()) this.db.exec(`DELETE FROM chunks_fts_${language}`);
    }
  }

  close(): void {
    void this.lexical?.close();
    this.db.close();
  }

  async sync(messages: MailMessage[], policy: ClassificationPolicy = {}): Promise<SyncReport> {
    return this.runExclusive(() => this.syncUnlocked(messages, policy));
  }

  status(): { messageCount: number; chunkCount: number; embeddingBacklog: number; vectorCount: number; archiveRevision: string; fts: { status: "healthy" | "stale"; rows: number } } {
    const count = (table: "messages" | "chunks"): number =>
      Number((this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    const ftsRows = Number((this.db.prepare("SELECT COUNT(*) AS count FROM chunks_fts").get() as { count: number }).count);
    const metadata = this.db.prepare("SELECT version FROM lexical_index_meta WHERE id = 1").get() as { version: string } | undefined;
    const chunkCount = count("chunks");
    return {
      messageCount: count("messages"),
      chunkCount,
      embeddingBacklog: Number((this.db.prepare("SELECT COUNT(*) AS count FROM embedding_queue WHERE state = 'pending'").get() as { count: number }).count),
      // Vectors live in the Lance table now; queue-complete rows are committed 1:1 with them.
      vectorCount: Number((this.db.prepare("SELECT COUNT(*) AS count FROM embedding_queue WHERE state = 'complete'").get() as { count: number }).count),
      archiveRevision: this.revision(),
      fts: { status: metadata?.version === LEXICAL_ANALYZER_VERSION && ftsRows === chunkCount ? "healthy" : "stale", rows: ftsRows },
    };
  }

  /** Semantic index health from the vector-store identity plus the embedding queue. */
  async semanticSummary(): Promise<SemanticSummary> {
    const stats = this.status();
    const base = { vectorCount: stats.vectorCount, embeddingBacklog: stats.embeddingBacklog, archiveRevision: stats.archiveRevision };
    const store = await this.findStore();
    const identity = store?.readIdentity();
    if (!identity) {
      const stored = store ? await store.countRows() : 0;
      if (stored > 0) return { status: "rebuild-required", ...base, vectorCount: stored };
      const status = stats.embeddingBacklog > 0 ? (stats.vectorCount > 0 ? "interrupted" : "never-completed") : "missing";
      return { status, ...base };
    }
    const detail = { provider: identity.provider, model: identity.model, dimension: identity.dimension, ...base };
    if (!sameEmbedder(identity, embedderIdentity(this.embedderConfig))) return { status: "rebuild-required", ...detail };
    const stored = store ? await store.countRows() : 0;
    if (stats.embeddingBacklog > 0) return { status: "interrupted", ...detail, vectorCount: stored };
    if (stored !== stats.vectorCount) return { status: "corrupt", ...detail, vectorCount: stored };
    if (identity.indexedRevision && identity.indexedRevision !== stats.archiveRevision) return { status: "stale", ...detail };
    return { status: "healthy", ...detail };
  }

  private async syncUnlocked(messages: MailMessage[], policy: ClassificationPolicy = {}): Promise<SyncReport> {
    for (const message of messages) {
      if (typeof message.providerKey !== "string" || !message.providerKey.trim()) throw new Error("message provider identity is required");
    }
    const excludedCategories = new Set((policy.excludedCategories ?? ["spam", "promotions"]).map(normalizeCategory));
    const normalized = (await Promise.all(messages.map(normalizeMessage))).map((message) => ({
      ...message,
      messageId: scopedId(message.accountId, message.mailbox, message.messageId),
      threadId: scopedId(message.accountId, message.mailbox, message.threadId),
      providerKey: scopedId(message.accountId, message.mailbox, message.providerKey),
      inReplyTo: message.inReplyTo ? scopedId(message.accountId, message.mailbox, message.inReplyTo) : undefined,
    }));
    validateIdentities(normalized);
    validateStoredIdentities(this.db, normalized);
    const excluded = normalized.filter((message) => message.categories.some((category) => excludedCategories.has(category)));
    const included = normalized.filter((message) => !message.categories.some((category) => excludedCategories.has(category)));
    const existing = this.db.prepare("SELECT provider_key, normalized_hash FROM messages").all() as {
      provider_key: string; normalized_hash: string;
    }[];
    const previous = new Map(existing.map((row) => [row.provider_key, row.normalized_hash]));
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    const touched = new Set<string>();
    const rebuildLexical = this.lexicalRebuildRequired;
    const required = [...new Set(included.flatMap((message) => languagesForText(`${message.subject} ${message.text}`)))];
    if (required.length) this.lexical = await createLexicalAnalyzers(required);
    const analyzedChunks = new Map<string, Map<string, string>>();
    for (const message of included) {
      const oldHash = previous.get(message.providerKey);
      if (!this.lexicalRebuildRequired && oldHash === message.normalizedHash) continue;
      for (const chunk of buildChunks(message)) {
        const tokens = new Map<string, string>();
        for (const language of lexicalFields()) {
          tokens.set(language, languagesForText(chunk.text).includes(language)
            ? await this.lexical!.tokenize(language, chunk.text)
            : "");
        }
        analyzedChunks.set(chunk.chunkId, tokens);
      }
    }
    const transaction = this.db.transaction((items: NormalizedMessage[]) => {
      for (const message of items) {
        const oldHash = previous.get(message.providerKey);
        if (!oldHash) added++;
        else if (oldHash !== message.normalizedHash) updated++;
        else unchanged++;
        if (oldHash !== message.normalizedHash) touched.add(message.threadId);
        this.upsertMessage(message);
        if (rebuildLexical || oldHash !== message.normalizedHash) this.replaceMessageChunks(message, analyzedChunks);
      }
    });
    transaction(included);
    this.db.prepare(`INSERT INTO lexical_index_meta(id, version, rebuilt_at)
      VALUES (1, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET version=excluded.version, rebuilt_at=excluded.rebuilt_at`).run(LEXICAL_ANALYZER_VERSION);
    this.lexicalRebuildRequired = false;
    for (const message of excluded) this.removeMessage(message);
    const chunks = Number((this.db.prepare("SELECT COUNT(*) AS count FROM chunks").get() as { count: number }).count);
    const backlog = Number((this.db.prepare("SELECT COUNT(*) AS count FROM embedding_queue WHERE state = 'pending'").get() as { count: number }).count);
    return {
      added, updated, deleted: 0, unchanged, touchedThreads: touched.size,
      rebuiltThreads: touched.size, chunksAdded: chunks, chunksDeleted: 0,
      embeddingBacklog: backlog, archiveRevision: this.revision(),
      excluded: excluded.length,
      excludedByReason: countExcluded(excluded, excludedCategories),
    };
  }

  async searchBm25(query: string, filters: SearchFilters = {}, limit = 10): Promise<SearchHit[]> {
    if (!query.trim()) throw new Error("empty query");
    if (this.lexicalRebuildRequired && languagesForText(query).length) {
      throw new Error("lexical indexes are stale; run sync before multilingual search");
    }
    const languages = languagesForText(query);
    if (languages.length) this.lexical ??= await createLexicalAnalyzers(languages);
    const lists = [this.searchLexicalTable("chunks_fts", query, filters, limit * 2)];
    for (const language of languagesForText(query)) {
      lists.push(this.searchLexicalTable(`chunks_fts_${language}`, await this.lexical!.tokenize(language, query), filters, limit * 2));
    }
    const merged = new Map<string, { hit: SearchHit; score: number }>();
    const k = 60;
    for (const list of lists) {
      for (const [index, hit] of list.entries()) {
        const rank = index + 1;
        const prior = merged.get(hit.chunkId);
        merged.set(hit.chunkId, prior ? { hit: prior.hit, score: prior.score + 1 / (k + rank) } : { hit, score: 1 / (k + rank) });
      }
    }
    return [...merged.values()].sort((a, b) => b.score - a.score || a.hit.chunkId.localeCompare(b.hit.chunkId))
      .slice(0, limit).map(({ hit, score }) => ({ ...hit, score }));
  }

  async indexSemantic(options: { rebuild?: boolean } = {}): Promise<SemanticIndexReport> {
    return this.runExclusive(() => this.indexSemanticUnlocked(options.rebuild === true));
  }

  private async indexSemanticUnlocked(rebuild: boolean): Promise<SemanticIndexReport> {
    const expected = embedderIdentity(this.embedderConfig);
    const store = await this.getStore();
    let rebuilt = false;
    const existingIdentity = store.readIdentity();
    const orphanedTable = !existingIdentity && (await store.countRows()) > 0;
    if (rebuild || orphanedTable || (existingIdentity && !sameEmbedder(existingIdentity, expected))) {
      // Identity is data: a mismatch, a missing sidecar next to existing
      // vectors, or an explicit rebuild discards the table. Never silent reuse.
      if (existingIdentity || rebuild || orphanedTable) {
        await store.drop();
        rebuilt = true;
      }
      this.discardLegacyVectors();
      this.resetQueuePending();
      await store.ensureTable(expected.dimension);
      store.writeIdentity(expected);
    } else if (!existingIdentity) {
      const legacy = this.readLegacyVectors();
      const importable = legacy && sameEmbedder(legacyEmbedderIdentity(legacy.model, legacy.vector.length), expected);
      if (importable) await this.importLegacyVectors(store);
      else {
        if (legacy) {
          this.discardLegacyVectors();
          this.resetQueuePending();
        }
        await store.ensureTable(expected.dimension);
      }
      store.writeIdentity(expected);
    }
    const completeQueueRow = this.db.prepare("UPDATE embedding_queue SET state = 'complete' WHERE chunk_id = ?");
    const reconcile = this.db.transaction(() => {
      this.db.prepare("DELETE FROM embedding_queue WHERE chunk_id NOT IN (SELECT chunk_id FROM chunks)").run();
      this.db.prepare(`INSERT INTO embedding_queue(chunk_id, content_hash, state, attempts)
        SELECT chunk_id, content_hash, 'pending', 0 FROM chunks
        WHERE chunk_id NOT IN (SELECT chunk_id FROM embedding_queue)`).run();
    });
    reconcile();
    await this.sweepOrphanedVectors(store);
    const batchSize = embeddingBatchSize(this.embedderConfig);
    const pageQuery = this.db.prepare(`SELECT c.chunk_id, c.text, c.content_hash, c.account_id, c.mailbox,
      c.thread_id, c.message_id, m.date, lower(m.from_address) AS from_address
      FROM chunks c JOIN messages m ON m.message_id = c.message_id
      ORDER BY c.chunk_id LIMIT ? OFFSET ?`);
    const queueQuery = this.db.prepare("SELECT content_hash, state FROM embedding_queue WHERE chunk_id = ?");
    let embedded = 0;
    let reused = 0;
    let embedder: Embedder | undefined;
    for (let offset = 0; ; offset += batchSize) {
      const rows = pageQuery.all(batchSize, offset) as ChunkPageRow[];
      if (!rows.length) break;
      // Reuse is decided against the stored vectors' content hashes, so a
      // re-enqueued queue row (or a crash between the Lance commit and the
      // queue commit) never re-embeds an unchanged chunk.
      const storedHashes = await store.contentHashes(rows.map((row) => row.chunk_id));
      const batch: ChunkPageRow[] = [];
      for (const row of rows) {
        if (storedHashes.get(row.chunk_id) === row.content_hash) {
          const queued = queueQuery.get(row.chunk_id) as { content_hash: string; state: string } | undefined;
          if (queued?.state !== "complete") completeQueueRow.run(row.chunk_id);
          reused++;
          continue;
        }
        batch.push(row);
      }
      if (!batch.length) continue;
      embedder ??= await this.getEmbedder();
      const vectors = await embedder.embedDocuments(batch.map((row) => row.text));
      if (vectors.length !== batch.length) throw new Error("embedder returned an unexpected embedding count");
      const docs = batch.map((row, index) => ({
        chunkId: row.chunk_id,
        vector: vectors[index],
        contentHash: row.content_hash,
        accountId: row.account_id,
        mailbox: row.mailbox,
        threadId: row.thread_id,
        messageId: row.message_id,
        date: row.date,
        fromAddress: row.from_address,
      }));
      await store.upsert(docs);
      // Per-batch commit: the Lance upsert lands first, then the queue rows.
      // A crash in between re-embeds at most one batch on the next run.
      const commit = this.db.transaction(() => {
        for (const doc of docs) {
          completeQueueRow.run(doc.chunkId);
          embedded++;
        }
      });
      commit();
    }
    const identity = store.readIdentity();
    if (identity) store.writeIdentity({ ...identity, indexedRevision: this.revision() });
    return { embedded, reused, archiveRevision: this.revision(), rebuilt };
  }

  /** Vector rows left behind by removed messages are swept at index time. */
  private async sweepOrphanedVectors(store: SemanticStore): Promise<void> {
    const chunkIds = new Set((this.db.prepare("SELECT chunk_id FROM chunks").all() as { chunk_id: string }[]).map((row) => row.chunk_id));
    const stored = await store.listChunkIds();
    const orphaned = stored.filter((chunkId) => !chunkIds.has(chunkId));
    if (orphaned.length) await store.deleteChunkIds(orphaned);
  }

  private readLegacyVectors(): { chunk_id: string; content_hash: string; model: string; vector: number[] } | undefined {
    const table = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'semantic_vectors'").get();
    if (!table) return undefined;
    const rows = this.db.prepare("SELECT chunk_id, content_hash, model, vector FROM semantic_vectors ORDER BY chunk_id").all() as { chunk_id: string; content_hash: string; model: string; vector: string }[];
    if (!rows.length) return undefined;
    const first = rows[0];
    let vector: number[];
    try {
      vector = JSON.parse(first.vector) as number[];
    } catch {
      return undefined;
    }
    if (!Array.isArray(vector) || !vector.length) return undefined;
    return { chunk_id: first.chunk_id, content_hash: first.content_hash, model: first.model, vector };
  }

  private async importLegacyVectors(store: SemanticStore): Promise<number> {
    const rows = this.db.prepare("SELECT chunk_id, content_hash, vector FROM semantic_vectors ORDER BY chunk_id").all() as { chunk_id: string; content_hash: string; vector: string }[];
    const chunkQuery = this.db.prepare(`SELECT c.chunk_id, c.account_id, c.mailbox, c.thread_id, c.message_id,
      c.content_hash, m.date, lower(m.from_address) AS from_address
      FROM chunks c JOIN messages m ON m.message_id = c.message_id`);
    const chunks = new Map((chunkQuery.all() as ChunkPageRow[]).map((row) => [row.chunk_id, row]));
    const completeQueue = this.db.prepare("UPDATE embedding_queue SET state = 'complete' WHERE chunk_id = ?");
    const docs = [];
    const imported: string[] = []
    for (const row of rows) {
      const chunk = chunks.get(row.chunk_id);
      if (!chunk || chunk.content_hash !== row.content_hash) continue;
      let vector: number[];
      try {
        vector = JSON.parse(row.vector) as number[];
      } catch {
        continue;
      }
      docs.push({
        chunkId: row.chunk_id, vector, contentHash: row.content_hash,
        accountId: chunk.account_id, mailbox: chunk.mailbox, threadId: chunk.thread_id,
        messageId: chunk.message_id, date: chunk.date, fromAddress: chunk.from_address,
      });
      imported.push(row.chunk_id);
    }
    if (docs.length) await store.upsert(docs);
    const commit = this.db.transaction(() => {
      for (const chunkId of imported) completeQueue.run(chunkId);
    });
    commit();
    this.discardLegacyVectors();
    return docs.length;
  }

  private discardLegacyVectors(): void {
    this.db.exec("DROP TABLE IF EXISTS semantic_vectors");
  }

  private resetQueuePending(): void {
    this.db.exec("UPDATE embedding_queue SET state = 'pending', attempts = 0");
  }

  async searchSemantic(query: string, filters: SearchFilters = {}, limit = 10): Promise<SearchHit[]> {
    if (!query.trim()) throw new Error("empty query");
    const store = await this.findStore();
    const identity = store?.readIdentity();
    if (!store || !identity) return [];
    const expected = embedderIdentity(this.embedderConfig);
    if (!sameEmbedder(identity, expected)) {
      throw new Error(`semantic index embedder mismatch: indexed with ${embedderIdentityLabel(identity)}, active embedder is ${embedderIdentityLabel(expected)}; run mailcrawl index to rebuild`);
    }
    const queryVector = await (await this.getEmbedder()).embedQuery(query);
    // `to` lives in SQLite json_each, so it cannot be a Lance predicate: over-fetch, then post-filter.
    const fetchLimit = filters.to ? Math.min(limit * 10, 1000) : limit;
    const hits = await store.query(queryVector, filters, fetchLimit);
    if (!hits.length) return [];
    const scoreById = new Map(hits.map((hit) => [hit.chunkId, hit.score]));
    const clauses = [`c.chunk_id IN (${hits.map(() => "?").join(", ")})`];
    const params: unknown[] = hits.map((hit) => hit.chunkId);
    addFilters(clauses, params, filters);
    const rows = this.db.prepare(`SELECT c.chunk_id, c.message_id, c.thread_id, c.account_id, c.mailbox,
      m.subject, m.from_address, m.to_addresses, m.date, c.text
      FROM chunks c JOIN messages m ON m.message_id = c.message_id
      WHERE ${clauses.join(" AND ")}`).all(...params) as SemanticRow[];
    return rows
      .map((row) => ({ row, score: scoreById.get(row.chunk_id) }))
      .filter((hit): hit is { row: SemanticRow; score: number } => hit.score !== undefined)
      .sort((a, b) => b.score - a.score || a.row.chunk_id.localeCompare(b.row.chunk_id))
      .slice(0, limit)
      .map(({ row, score }) => ({
        chunkId: row.chunk_id, messageId: row.message_id, threadId: row.thread_id,
        accountId: row.account_id, mailbox: row.mailbox, subject: row.subject,
        from: row.from_address, to: JSON.parse(row.to_addresses), date: row.date,
        snippet: snippet(row.text, query), score, mode: "semantic" as const,
      }));
  }

  async searchHybrid(query: string, filters: SearchFilters = {}, limit = 10): Promise<SearchHit[]> {
    const lexical = await this.searchBm25(query, filters, limit * 2);
    const semantic = await this.searchSemantic(query, filters, limit * 2);
    const merged = new Map<string, { hit: SearchHit; score: number }>();
    const k = 60;
    for (const [index, hit] of lexical.entries()) merged.set(hit.chunkId, { hit: { ...hit, mode: "hybrid" }, score: 1 / (k + index + 1) });
    for (const [index, hit] of semantic.entries()) {
      const prior = merged.get(hit.chunkId);
      const score = 1 / (k + index + 1);
      merged.set(hit.chunkId, prior
        ? { hit: { ...prior.hit, mode: "hybrid" }, score: prior.score + score }
        : { hit: { ...hit, mode: "hybrid" }, score });
    }
    return [...merged.values()]
      .sort((a, b) => b.score - a.score || a.hit.chunkId.localeCompare(b.hit.chunkId))
      .slice(0, limit)
      .map(({ hit, score }) => ({ ...hit, score }));
  }

  getMessage(messageId: string): NormalizedMessage | undefined {
    const row = this.db.prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId) as MessageRow | undefined;
    return row && messageRow(row);
  }

  listAttachments(messageId?: string): Array<{
    attachmentId: string;
    messageId: string;
    name: string;
    mimeType: string;
    size: number | null;
    contentHash: string | null;
    extractedText: string | null;
  }> {
    const rows = (messageId
      ? this.db.prepare("SELECT * FROM attachments WHERE message_id = ? ORDER BY attachment_id").all(messageId)
      : this.db.prepare("SELECT * FROM attachments ORDER BY message_id, attachment_id").all()) as AttachmentRow[];
    return rows.map((row) => ({
      attachmentId: row.attachment_id,
      messageId: row.message_id,
      name: row.name,
      mimeType: row.mime_type,
      size: row.size,
      contentHash: row.content_hash,
      extractedText: row.extracted_text,
    }));
  }

  getThread(threadId: string, filters: SearchFilters = {}): NormalizedMessage[] {
    const clauses = ["thread_id = ?"];
    const params: unknown[] = [threadId];
    addFilters(clauses, params, filters);
    return (this.db.prepare(`SELECT * FROM messages WHERE ${clauses.join(" AND ")} ORDER BY date, message_id`).all(...params) as MessageRow[]).map(messageRow);
  }

  getThreadContext(threadId: string, messageId?: string): { previous: NormalizedMessage[]; current?: NormalizedMessage; next: NormalizedMessage[] } {
    const messages = this.getThread(threadId);
    const index = messageId ? messages.findIndex((message) => message.messageId === messageId) : 0;
    const current = index >= 0 ? messages[index] : undefined;
    return {
      previous: index > 0 ? messages.slice(0, index) : [],
      current,
      next: index >= 0 ? messages.slice(index + 1) : messages,
    };
  }

  getChunkContext(chunkId: string): { previous?: Chunk; current?: Chunk; next?: Chunk } {
    const current = this.db.prepare("SELECT * FROM chunks WHERE chunk_id = ?").get(chunkId) as ChunkRow | undefined;
    if (!current) return {};
    const base = this.db.prepare("SELECT * FROM chunks WHERE thread_id = ? AND (started_at < ? OR (started_at = ? AND rowid < ?)) ORDER BY started_at DESC, rowid DESC LIMIT 1").get(current.thread_id, current.started_at, current.started_at, current.rowid) as ChunkRow | undefined;
    const next = this.db.prepare("SELECT * FROM chunks WHERE thread_id = ? AND (started_at > ? OR (started_at = ? AND rowid > ?)) ORDER BY started_at, rowid LIMIT 1").get(current.thread_id, current.started_at, current.started_at, current.rowid) as ChunkRow | undefined;
    return { previous: base && chunkRow(base), current: chunkRow(current), next: next && chunkRow(next) };
  }

  repairFts(): { rows: number; status: "repaired" } {
    const rows = this.db.prepare("SELECT rowid, chunk_id, text, message_id FROM chunks").all() as {
      rowid: number; chunk_id: string; text: string; message_id: string;
    }[];
    const rebuild = this.db.transaction(() => {
      this.db.exec("DELETE FROM chunks_fts");
      for (const row of rows) {
        const message = this.db.prepare("SELECT * FROM messages WHERE message_id = ?").get(row.message_id) as MessageRow;
        this.db.prepare(`INSERT INTO chunks_fts(rowid, subject, from_address, to_addresses, thread_subject,
          body_latest, body_quoted, forwarded_text, attachment_text)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.rowid, message.subject, message.from_address,
          message.to_addresses, message.subject, row.text, "", "", message.attachment_text || "");
      }
    });
    rebuild();
    return { rows: rows.length, status: "repaired" };
  }

  private upsertMessage(message: NormalizedMessage): void {
    this.db.prepare(`INSERT INTO messages
      (message_id, account_id, mailbox, provider_key, thread_id, in_reply_to, subject, from_address,
       to_addresses, cc_addresses, date, latest_text, quoted_text, attachment_text, normalized_hash,
       labels, flags, classifications)
      VALUES (@messageId, @accountId, @mailbox, @providerKey, @threadId, @inReplyTo, @subject, @from,
       @to, @cc, @date, @latestText, @quotedText, @attachmentText, @normalizedHash,
       @labels, @flags, @classifications)
      ON CONFLICT(message_id) DO UPDATE SET account_id=excluded.account_id, mailbox=excluded.mailbox,
       provider_key=excluded.provider_key, thread_id=excluded.thread_id, in_reply_to=excluded.in_reply_to,
       subject=excluded.subject, from_address=excluded.from_address, to_addresses=excluded.to_addresses,
       cc_addresses=excluded.cc_addresses, date=excluded.date, latest_text=excluded.latest_text,
       quoted_text=excluded.quoted_text, attachment_text=excluded.attachment_text,
       normalized_hash=excluded.normalized_hash, labels=excluded.labels, flags=excluded.flags,
       classifications=excluded.classifications`).run({
      ...message, inReplyTo: message.inReplyTo ?? null,
      to: JSON.stringify(message.to), cc: JSON.stringify(message.cc),
      labels: JSON.stringify(message.labels ?? []), flags: JSON.stringify(message.flags ?? []),
      classifications: JSON.stringify(message.classifications ?? []),
      attachmentText: attachmentText(message),
    });
    this.db.prepare("DELETE FROM attachments WHERE message_id = ?").run(message.messageId);
    for (const [index, attachment] of (message.attachments || []).entries()) {
      this.db.prepare(`INSERT INTO attachments
        (attachment_id, message_id, name, mime_type, size, content_hash, extracted_text)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(`${message.messageId}:${index}`, message.messageId,
        attachment.name, attachment.mimeType, attachment.size ?? null,
        attachment.contentHash ?? null, attachment.text ?? null);
    }
  }

  private removeMessage(message: NormalizedMessage): void {
    const rows = this.db.prepare("SELECT rowid FROM chunks WHERE message_id = (SELECT message_id FROM messages WHERE provider_key = ?)").all(message.providerKey) as { rowid: number }[];
    for (const row of rows) this.db.prepare("DELETE FROM chunks_fts WHERE rowid = ?").run(row.rowid);
    for (const language of lexicalFields()) this.db.prepare(`DELETE FROM chunks_fts_${language} WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE message_id = (SELECT message_id FROM messages WHERE provider_key = ?))`).run(message.providerKey);
    this.db.prepare("DELETE FROM embedding_queue WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE message_id = (SELECT message_id FROM messages WHERE provider_key = ?))").run(message.providerKey);
    // Stale vector rows are swept from the Lance table at the next index run.
    this.db.prepare("DELETE FROM messages WHERE provider_key = ?").run(message.providerKey);
  }

  private replaceMessageChunks(message: NormalizedMessage, analyzedChunks?: Map<string, Map<string, string>>): void {
    const old = this.db.prepare("SELECT rowid, chunk_id FROM chunks WHERE message_id = ?").all(message.messageId) as { rowid: number; chunk_id: string }[];
    for (const row of old) this.db.prepare("DELETE FROM chunks_fts WHERE rowid = ?").run(row.rowid);
    for (const language of lexicalFields()) this.db.prepare(`DELETE FROM chunks_fts_${language} WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE message_id = ?)`).run(message.messageId);
    this.db.prepare("DELETE FROM embedding_queue WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE message_id = ?)").run(message.messageId);
    this.db.prepare("DELETE FROM chunks WHERE message_id = ?").run(message.messageId);
    for (const chunk of buildChunks(message)) {
      const result = this.db.prepare(`INSERT INTO chunks
        (chunk_id, account_id, mailbox, message_id, thread_id, section, ordinal, text, started_at, ended_at, content_hash)
        VALUES (@chunkId, @accountId, @mailbox, @messageId, @threadId, @section, @ordinal, @text, @startedAt, @endedAt, @contentHash)`).run(chunk);
      this.db.prepare(`INSERT INTO chunks_fts(rowid, subject, from_address, to_addresses, thread_subject,
        body_latest, body_quoted, forwarded_text, attachment_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(result.lastInsertRowid, message.subject, message.from,
        message.to.join(" "), message.normalizedSubject,
        chunk.section === "latest" ? chunk.text : "",
        chunk.section === "quoted" ? chunk.text : "",
        "", chunk.section === "attachment" ? chunk.text : "");
      for (const language of lexicalFields()) {
        this.db.prepare(`INSERT INTO chunks_fts_${language}(chunk_id, text, subject, from_address, to_addresses)
          VALUES (?, ?, ?, ?, ?)`).run(chunk.chunkId, analyzedChunks?.get(chunk.chunkId)?.get(language) ?? "",
          message.subject, message.from, message.to.join(" "));
      }
      this.db.prepare(`INSERT INTO embedding_queue(chunk_id, content_hash, state, attempts)
        VALUES (?, ?, 'pending', 0) ON CONFLICT(chunk_id) DO UPDATE SET content_hash=excluded.content_hash, state='pending'`).run(chunk.chunkId, chunk.contentHash);
    }
  }

  private revision(): string {
    const rows = this.db.prepare("SELECT chunk_id, content_hash FROM chunks ORDER BY chunk_id").all() as { chunk_id: string; content_hash: string }[];
    return createHash("sha256").update(rows.map((row) => `${row.chunk_id}\0${row.content_hash}`).join("\0")).digest("hex");
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release = (): void => {};
    const turn = new Promise<void>((resolve) => { release = resolve; });
    this.operationTail = previous.then(() => turn);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async getEmbedder(): Promise<Embedder> {
    this.embedder ??= await createEmbedder(this.embedderConfig);
    return this.embedder;
  }

  /** Opens (and creates if needed) the semantic vector store for indexing. */
  private async getStore(): Promise<SemanticStore> {
    if (this.store) return this.store;
    if (this.dataDir === undefined) {
      this.store = new MemorySemanticStore();
      return this.store;
    }
    const identity = embedderIdentity(this.embedderConfig);
    this.store = await LanceSemanticStore.open(this.dataDir, identity.dimension);
    return this.store;
  }

  /** Opens the store only when one already exists; read paths never create. */
  private async findStore(): Promise<SemanticStore | undefined> {
    if (this.store) return this.store;
    if (this.dataDir === undefined) return undefined;
    const existing = await LanceSemanticStore.openExisting(this.dataDir);
    if (existing) this.store = existing;
    return existing;
  }

  private searchLexicalTable(table: string, query: string, filters: SearchFilters, limit: number): SearchHit[] {
    const clauses = [`${table} MATCH ?`];
    const params: unknown[] = [literalFtsQuery(query)];
    addFilters(clauses, params, filters);
    const join = table === "chunks_fts"
      ? `JOIN chunks c ON c.rowid = ${table}.rowid`
      : `JOIN chunks c ON c.chunk_id = ${table}.chunk_id`;
    const sql = `SELECT c.chunk_id, c.message_id, c.thread_id, c.account_id, c.mailbox,
      m.subject, m.from_address, m.to_addresses, m.date,
      bm25(${table}) AS score
      FROM ${table} ${join}
      JOIN messages m ON m.message_id = c.message_id
      WHERE ${clauses.join(" AND ")} ORDER BY score LIMIT ?`;
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as SearchRow[]).map((row) => hydrate(row, "bm25", query));
  }
}

function migrate(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, mailbox TEXT NOT NULL,
    provider_key TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL, in_reply_to TEXT,
    subject TEXT NOT NULL, from_address TEXT NOT NULL, to_addresses TEXT NOT NULL,
    cc_addresses TEXT NOT NULL, date TEXT NOT NULL, latest_text TEXT NOT NULL,
    quoted_text TEXT NOT NULL, attachment_text TEXT NOT NULL DEFAULT '', normalized_hash TEXT NOT NULL,
    labels TEXT NOT NULL DEFAULT '[]', flags TEXT NOT NULL DEFAULT '[]',
    classifications TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, mailbox TEXT NOT NULL,
    message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL, section TEXT NOT NULL, ordinal INTEGER NOT NULL,
    text TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT NOT NULL, content_hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chunks_thread_time ON chunks(thread_id, started_at);
  CREATE TABLE IF NOT EXISTS embedding_queue (
    chunk_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL
  );
  -- Pre-#39 archives keep a legacy semantic_vectors JSON table until the
  -- first index run imports or discards it (see indexSemanticUnlocked).
  CREATE TABLE IF NOT EXISTS attachments (
    attachment_id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
    name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER, content_hash TEXT, extracted_text TEXT
  );
  CREATE TABLE IF NOT EXISTS lexical_index_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1), version TEXT NOT NULL, rebuilt_at TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    subject, from_address, to_addresses, thread_subject, body_latest,
    body_quoted, forwarded_text, attachment_text,
    tokenize = 'unicode61'
  );`);
  // Legacy (pre-#39) semantic_vectors table: add the model column when an old
  // archive still carries it, so indexSemantic can import or discard it.
  const legacyVectorsPresent = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'semantic_vectors'").get() !== undefined;
  if (legacyVectorsPresent) {
    const vectorColumns = db.prepare("PRAGMA table_info(semantic_vectors)").all() as Array<{ name: string }>;
    if (!vectorColumns.some((column) => column.name === "model")) db.exec("ALTER TABLE semantic_vectors ADD COLUMN model TEXT NOT NULL DEFAULT ''");
  }
  for (const language of lexicalFields()) {
    const table = `chunks_fts_${language}`;
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(
      chunk_id UNINDEXED, text, subject, from_address, to_addresses,
      tokenize = 'unicode61'
    );`);
  }
  const columns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  const existingColumns = new Set(columns.map((column) => column.name));
  for (const column of ["labels", "flags", "classifications"]) {
    if (!existingColumns.has(column)) db.exec(`ALTER TABLE messages ADD COLUMN ${column} TEXT NOT NULL DEFAULT '[]'`);
  }
}

function cleanupOrphanedSemanticRows(db: Database.Database): void {
  db.prepare(`DELETE FROM embedding_queue
    WHERE NOT EXISTS (SELECT 1 FROM chunks WHERE chunks.chunk_id = embedding_queue.chunk_id)`).run();
}

function literalFtsQuery(query: string): string {
  return query.trim().split(/\s+/).map((term) => `"${term.replaceAll('"', '""')}"`).join(" ");
}

function addFilters(clauses: string[], params: unknown[], filters: SearchFilters): void {
  if (filters.accountId) { clauses.push("c.account_id = ?"); params.push(filters.accountId); }
  if (filters.mailbox) { clauses.push("c.mailbox = ?"); params.push(filters.mailbox); }
  if (filters.from) { clauses.push("lower(m.from_address) = lower(?)"); params.push(filters.from); }
  if (filters.to) { clauses.push("EXISTS (SELECT 1 FROM json_each(m.to_addresses) WHERE lower(value) = lower(?))"); params.push(filters.to); }
  if (filters.threadId) { clauses.push("c.thread_id = ?"); params.push(filters.threadId); }
  if (filters.after) { clauses.push("m.date >= ?"); params.push(filters.after); }
  if (filters.before) { clauses.push("m.date <= ?"); params.push(filters.before); }
}

function normalizeCategory(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/^category[_-]/, "").replace(/^label[_-]/, "");
}

function validateIdentities(messages: NormalizedMessage[]): void {
  const providerKeys = new Set<string>();
  const messageIds = new Set<string>();
  for (const message of messages) {
    if (!message.providerKey) throw new Error("message provider identity is required");
    if (providerKeys.has(message.providerKey)) throw new Error("duplicate message provider identity");
    providerKeys.add(message.providerKey);
    if (messageIds.has(message.messageId)) throw new Error("duplicate message identity");
    messageIds.add(message.messageId);
  }
}

function validateStoredIdentities(db: Database.Database, messages: NormalizedMessage[]): void {
  const byProviderKey = db.prepare("SELECT message_id FROM messages WHERE provider_key = ?");
  for (const message of messages) {
    const storedProvider = byProviderKey.get(message.providerKey) as { message_id: string } | undefined;
    if (storedProvider && storedProvider.message_id !== message.messageId) throw new Error("provider identity already belongs to another message identity");
  }
}

function countExcluded(messages: NormalizedMessage[], excluded: Set<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const message of messages) {
    for (const category of message.categories) {
      if (excluded.has(category)) counts[category] = (counts[category] ?? 0) + 1;
    }
  }
  return counts;
}

type SearchRow = { chunk_id: string; message_id: string; thread_id: string; account_id: string; mailbox: string; subject: string; from_address: string; to_addresses: string; date: string; snippet: string; score: number };
type SemanticRow = Omit<SearchRow, "snippet" | "score"> & { text: string };
type ChunkPageRow = { chunk_id: string; text: string; content_hash: string; account_id: string; mailbox: string; thread_id: string; message_id: string; date: string; from_address: string };
type AttachmentRow = {
  attachment_id: string;
  message_id: string;
  name: string;
  mime_type: string;
  size: number | null;
  content_hash: string | null;
  extracted_text: string | null;
};
type MessageRow = Record<string, string | null>;
type ChunkRow = { rowid: number; chunk_id: string; account_id: string; mailbox: string; message_id: string; thread_id: string; section: string; ordinal: number; text: string; started_at: string; ended_at: string; content_hash: string };

function hydrate(row: SearchRow, mode: "bm25", query: string): SearchHit {
  return { chunkId: row.chunk_id, messageId: row.message_id, threadId: row.thread_id, accountId: row.account_id, mailbox: row.mailbox, subject: row.subject, from: row.from_address, to: JSON.parse(row.to_addresses), date: row.date, snippet: row.snippet || snippet(row.subject, query), score: row.score, mode };
}

function messageRow(row: MessageRow): NormalizedMessage {
  return { accountId: row.account_id as string, mailbox: row.mailbox as string, providerKey: row.provider_key as string, messageId: row.message_id as string, threadId: row.thread_id as string, inReplyTo: row.in_reply_to || undefined, subject: row.subject as string, from: row.from_address as string, to: JSON.parse(row.to_addresses as string), cc: JSON.parse(row.cc_addresses as string), date: row.date as string, text: row.latest_text as string, latestText: row.latest_text as string, quotedText: row.quoted_text as string, normalizedSubject: (row.subject as string).toLocaleLowerCase(), normalizedHash: row.normalized_hash as string, labels: JSON.parse(row.labels || "[]"), flags: JSON.parse(row.flags || "[]"), classifications: JSON.parse(row.classifications || "[]"), categories: [...new Set([...JSON.parse(row.labels || "[]"), ...JSON.parse(row.flags || "[]"), ...JSON.parse(row.classifications || "[]")].map(normalizeCategory))] };
}

function chunkRow(row: ChunkRow): Chunk {
  return { chunkId: row.chunk_id, accountId: row.account_id, mailbox: row.mailbox, messageId: row.message_id, threadId: row.thread_id, section: row.section, ordinal: row.ordinal, text: row.text, startedAt: row.started_at, endedAt: row.ended_at, contentHash: row.content_hash };
}

function attachmentText(message: NormalizedMessage): string {
  return (message.attachments || []).map((attachment) => attachment.text || "").filter(Boolean).join("\n");
}
