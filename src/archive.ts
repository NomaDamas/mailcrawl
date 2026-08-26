import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { Chunk, MailMessage, NormalizedMessage, SearchFilters, SearchHit, SyncReport } from "./types.js";
import { buildChunks } from "./chunk.js";
import { normalizeMessage } from "./normalize.js";
import { snippet } from "./util.js";

export class Archive {
  readonly db: Database.Database;

  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    migrate(this.db);
  }

  close(): void {
    this.db.close();
  }

  async sync(messages: MailMessage[]): Promise<SyncReport> {
    const normalized = (await Promise.all(messages.map(normalizeMessage))).map((message) => ({
      ...message,
      messageId: `${message.accountId}:${message.messageId}`,
      threadId: `${message.accountId}:${message.threadId}`,
      providerKey: `${message.accountId}:${message.providerKey}`,
      inReplyTo: message.inReplyTo ? `${message.accountId}:${message.inReplyTo}` : undefined,
    }));
    const existing = this.db.prepare("SELECT provider_key, normalized_hash FROM messages").all() as {
      provider_key: string; normalized_hash: string;
    }[];
    const previous = new Map(existing.map((row) => [row.provider_key, row.normalized_hash]));
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    const touched = new Set<string>();
    const transaction = this.db.transaction((items: NormalizedMessage[]) => {
      for (const message of items) {
        const oldHash = previous.get(message.providerKey);
        if (!oldHash) added++;
        else if (oldHash !== message.normalizedHash) updated++;
        else unchanged++;
        if (oldHash !== message.normalizedHash) touched.add(message.threadId);
        this.upsertMessage(message);
        if (oldHash !== message.normalizedHash) this.replaceMessageChunks(message);
      }
    });
    transaction(normalized);
    const chunks = Number((this.db.prepare("SELECT COUNT(*) AS count FROM chunks").get() as { count: number }).count);
    const backlog = Number((this.db.prepare("SELECT COUNT(*) AS count FROM embedding_queue WHERE state = 'pending'").get() as { count: number }).count);
    return {
      added, updated, deleted: 0, unchanged, touchedThreads: touched.size,
      rebuiltThreads: touched.size, chunksAdded: chunks, chunksDeleted: 0,
      embeddingBacklog: backlog, archiveRevision: this.revision(),
    };
  }

  searchBm25(query: string, filters: SearchFilters = {}, limit = 10): SearchHit[] {
    if (!query.trim()) throw new Error("empty query");
    const clauses = ["chunks_fts MATCH ?"];
    const params: unknown[] = [literalFtsQuery(query)];
    addFilters(clauses, params, filters);
    const sql = `SELECT c.chunk_id, c.message_id, c.thread_id, c.account_id, c.mailbox,
      m.subject, m.from_address, m.to_addresses, m.date, snippet(chunks_fts, 0, '[', ']', '…', 32) AS snippet,
      bm25(chunks_fts, 8.0, 5.0, 2.0, 1.0, 1.0, 1.0, 0.5) AS score
      FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid
      JOIN messages m ON m.message_id = c.message_id
      WHERE ${clauses.join(" AND ")} ORDER BY score LIMIT ?`;
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as SearchRow[]).map((row) => hydrate(row, "bm25", query));
  }

  indexSemantic(): { embedded: number; reused: number; archiveRevision: string } {
    const rows = this.db.prepare("SELECT chunk_id, text, content_hash FROM chunks ORDER BY chunk_id").all() as {
      chunk_id: string; text: string; content_hash: string;
    }[];
    let embedded = 0;
    let reused = 0;
    const upsert = this.db.prepare(`INSERT INTO semantic_vectors
      (chunk_id, content_hash, vector) VALUES (?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET content_hash=excluded.content_hash, vector=excluded.vector`);
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        const old = this.db.prepare("SELECT content_hash FROM semantic_vectors WHERE chunk_id = ?").get(row.chunk_id) as { content_hash: string } | undefined;
        if (old?.content_hash === row.content_hash) { reused++; continue; }
        upsert.run(row.chunk_id, row.content_hash, JSON.stringify(embed(row.text)));
        embedded++;
      }
    });
    transaction();
    return { embedded, reused, archiveRevision: this.revision() };
  }

  searchSemantic(query: string, filters: SearchFilters = {}, limit = 10): SearchHit[] {
    if (!query.trim()) throw new Error("empty query");
    const queryVector = embed(query);
    const clauses = ["1 = 1"];
    const params: unknown[] = [];
    addFilters(clauses, params, filters);
    const rows = this.db.prepare(`SELECT v.vector, c.chunk_id, c.message_id, c.thread_id, c.account_id, c.mailbox,
      m.subject, m.from_address, m.to_addresses, m.date, c.text
      FROM semantic_vectors v JOIN chunks c ON c.chunk_id = v.chunk_id JOIN messages m ON m.message_id = c.message_id
      WHERE ${clauses.join(" AND ")}`).all(...params) as SemanticRow[];
    return rows.map((row) => ({ row, score: dot(queryVector, JSON.parse(row.vector) as number[]) }))
      .sort((a, b) => b.score - a.score || a.row.chunk_id.localeCompare(b.row.chunk_id))
      .slice(0, limit)
      .map(({ row, score }) => ({
        chunkId: row.chunk_id, messageId: row.message_id, threadId: row.thread_id,
        accountId: row.account_id, mailbox: row.mailbox, subject: row.subject,
        from: row.from_address, to: JSON.parse(row.to_addresses), date: row.date,
        snippet: snippet(row.text, query), score, mode: "semantic" as const,
      }));
  }

  searchHybrid(query: string, filters: SearchFilters = {}, limit = 10): SearchHit[] {
    const lexical = this.searchBm25(query, filters, limit * 2);
    const semantic = this.searchSemantic(query, filters, limit * 2);
    const merged = new Map<string, SearchHit>();
    for (const [index, hit] of lexical.entries()) merged.set(hit.chunkId, { ...hit, score: 0.5 * (1 - index / Math.max(1, lexical.length)) });
    for (const [index, hit] of semantic.entries()) {
      const prior = merged.get(hit.chunkId);
      const score = 0.5 * (1 - index / Math.max(1, semantic.length));
      merged.set(hit.chunkId, prior ? { ...prior, score: prior.score + score, mode: "hybrid" } : { ...hit, score, mode: "hybrid" });
    }
    return [...merged.values()].sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId)).slice(0, limit);
  }

  getMessage(messageId: string): NormalizedMessage | undefined {
    const row = this.db.prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId) as MessageRow | undefined;
    return row && messageRow(row);
  }

  getThread(threadId: string, filters: SearchFilters = {}): NormalizedMessage[] {
    const clauses = ["thread_id = ?"];
    const params: unknown[] = [threadId];
    addFilters(clauses, params, filters);
    return (this.db.prepare(`SELECT * FROM messages WHERE ${clauses.join(" AND ")} ORDER BY date, message_id`).all(...params) as MessageRow[]).map(messageRow);
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
       to_addresses, cc_addresses, date, latest_text, quoted_text, attachment_text, normalized_hash)
      VALUES (@messageId, @accountId, @mailbox, @providerKey, @threadId, @inReplyTo, @subject, @from,
       @to, @cc, @date, @latestText, @quotedText, @attachmentText, @normalizedHash)
      ON CONFLICT(message_id) DO UPDATE SET account_id=excluded.account_id, mailbox=excluded.mailbox,
       provider_key=excluded.provider_key, thread_id=excluded.thread_id, in_reply_to=excluded.in_reply_to,
       subject=excluded.subject, from_address=excluded.from_address, to_addresses=excluded.to_addresses,
       cc_addresses=excluded.cc_addresses, date=excluded.date, latest_text=excluded.latest_text,
       quoted_text=excluded.quoted_text, attachment_text=excluded.attachment_text,
       normalized_hash=excluded.normalized_hash`).run({
      ...message, inReplyTo: message.inReplyTo ?? null,
      to: JSON.stringify(message.to), cc: JSON.stringify(message.cc),
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

  private replaceMessageChunks(message: NormalizedMessage): void {
    const old = this.db.prepare("SELECT rowid, chunk_id FROM chunks WHERE message_id = ?").all(message.messageId) as { rowid: number; chunk_id: string }[];
    for (const row of old) this.db.prepare("DELETE FROM chunks_fts WHERE rowid = ?").run(row.rowid);
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
      this.db.prepare(`INSERT INTO embedding_queue(chunk_id, content_hash, state, attempts)
        VALUES (?, ?, 'pending', 0) ON CONFLICT(chunk_id) DO UPDATE SET content_hash=excluded.content_hash, state='pending'`).run(chunk.chunkId, chunk.contentHash);
    }
  }

  private revision(): string {
    const rows = this.db.prepare("SELECT chunk_id, content_hash FROM chunks ORDER BY chunk_id").all() as { chunk_id: string; content_hash: string }[];
    return createHash("sha256").update(rows.map((row) => `${row.chunk_id}\0${row.content_hash}`).join("\0")).digest("hex");
  }
}

function migrate(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, mailbox TEXT NOT NULL,
    provider_key TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL, in_reply_to TEXT,
    subject TEXT NOT NULL, from_address TEXT NOT NULL, to_addresses TEXT NOT NULL,
    cc_addresses TEXT NOT NULL, date TEXT NOT NULL, latest_text TEXT NOT NULL,
    quoted_text TEXT NOT NULL, attachment_text TEXT NOT NULL DEFAULT '', normalized_hash TEXT NOT NULL
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
  CREATE TABLE IF NOT EXISTS semantic_vectors (
    chunk_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, vector TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attachments (
    attachment_id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
    name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER, content_hash TEXT, extracted_text TEXT
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    subject, from_address, to_addresses, thread_subject, body_latest,
    body_quoted, forwarded_text, attachment_text
  );`);
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

type SearchRow = { chunk_id: string; message_id: string; thread_id: string; account_id: string; mailbox: string; subject: string; from_address: string; to_addresses: string; date: string; snippet: string; score: number };
type SemanticRow = Omit<SearchRow, "snippet" | "score"> & { vector: string; text: string };
type MessageRow = Record<string, string | null>;
type ChunkRow = { rowid: number; chunk_id: string; account_id: string; mailbox: string; message_id: string; thread_id: string; section: string; ordinal: number; text: string; started_at: string; ended_at: string; content_hash: string };

function hydrate(row: SearchRow, mode: "bm25", query: string): SearchHit {
  return { chunkId: row.chunk_id, messageId: row.message_id, threadId: row.thread_id, accountId: row.account_id, mailbox: row.mailbox, subject: row.subject, from: row.from_address, to: JSON.parse(row.to_addresses), date: row.date, snippet: row.snippet || snippet(row.subject, query), score: row.score, mode };
}

function messageRow(row: MessageRow): NormalizedMessage {
  return { accountId: row.account_id as string, mailbox: row.mailbox as string, providerKey: row.provider_key as string, messageId: row.message_id as string, threadId: row.thread_id as string, inReplyTo: row.in_reply_to || undefined, subject: row.subject as string, from: row.from_address as string, to: JSON.parse(row.to_addresses as string), cc: JSON.parse(row.cc_addresses as string), date: row.date as string, text: row.latest_text as string, latestText: row.latest_text as string, quotedText: row.quoted_text as string, normalizedSubject: (row.subject as string).toLocaleLowerCase(), normalizedHash: row.normalized_hash as string };
}

function chunkRow(row: ChunkRow): Chunk {
  return { chunkId: row.chunk_id, accountId: row.account_id, mailbox: row.mailbox, messageId: row.message_id, threadId: row.thread_id, section: row.section, ordinal: row.ordinal, text: row.text, startedAt: row.started_at, endedAt: row.ended_at, contentHash: row.content_hash };
}

function attachmentText(message: NormalizedMessage): string {
  return (message.attachments || []).map((attachment) => attachment.text || "").filter(Boolean).join("\n");
}

function embed(text: string): number[] {
  const vector = new Array<number>(128).fill(0);
  const normalized = text.toLocaleLowerCase().normalize("NFKC");
  for (let index = 0; index < normalized.length; index++) {
    const code = normalized.codePointAt(index) ?? 0;
    vector[(code + index * 31) % vector.length] += 1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

function dot(left: number[], right: number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}
