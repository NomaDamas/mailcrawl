import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClassificationPolicy, Chunk, MailMessage, NormalizedMessage, SearchFilters, SearchHit, SyncReport } from "./types.js";
import { buildChunks } from "./chunk.js";
import { normalizeMessage } from "./normalize.js";
import { scopedId, snippet } from "./util.js";
import { createEmbedder, embeddingModelName, type Embedder } from "./embedding.js";
import { createLexicalAnalyzers, languagesForText, lexicalFields, LEXICAL_ANALYZER_VERSION, tokenizeForLanguage, type LexicalAnalyzers } from "./lexical.js";

export class Archive {
  readonly db: Database.Database;
  private embedder?: Embedder;
  private lexical?: LexicalAnalyzers;
  private lexicalRebuildRequired: boolean;

  constructor(path = ":memory:") {
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

  async indexSemantic(): Promise<{ embedded: number; reused: number; archiveRevision: string }> {
    const completeQueueRow = this.db.prepare("UPDATE embedding_queue SET state = 'complete' WHERE chunk_id = ?");
    const reconcile = this.db.transaction(() => {
      this.db.prepare("DELETE FROM embedding_queue WHERE chunk_id NOT IN (SELECT chunk_id FROM chunks)").run();
      this.db.prepare(`INSERT INTO embedding_queue(chunk_id, content_hash, state, attempts)
        SELECT chunk_id, content_hash, 'pending', 0 FROM chunks
        WHERE chunk_id NOT IN (SELECT chunk_id FROM embedding_queue)`).run();
    });
    reconcile();
    const rows = this.db.prepare("SELECT chunk_id, text, content_hash FROM chunks ORDER BY chunk_id").all() as {
      chunk_id: string; text: string; content_hash: string;
    }[];
    let embedded = 0;
    let reused = 0;
    const upsert = this.db.prepare(`INSERT INTO semantic_vectors
      (chunk_id, content_hash, model, vector) VALUES (?, ?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET content_hash=excluded.content_hash, model=excluded.model, vector=excluded.vector`);
    const pending: typeof rows = [];
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        const old = this.db.prepare("SELECT content_hash, model FROM semantic_vectors WHERE chunk_id = ?").get(row.chunk_id) as { content_hash: string; model: string } | undefined;
        if (old?.content_hash === row.content_hash && old.model === embeddingModelName()) {
          completeQueueRow.run(row.chunk_id);
          reused++;
          continue;
        }
        pending.push(row);
      }
    });
    transaction();
    if (!pending.length) return { embedded, reused, archiveRevision: this.revision() };
    const embedder = await this.getEmbedder();
    const vectors = await embedder.embedDocuments(pending.map((row) => row.text));
    const write = this.db.transaction(() => {
      for (const [index, row] of pending.entries()) {
        upsert.run(row.chunk_id, row.content_hash, embeddingModelName(), JSON.stringify(vectors[index]));
        completeQueueRow.run(row.chunk_id);
        embedded++;
      }
    });
    write();
    return { embedded, reused, archiveRevision: this.revision() };
  }

  async indexSemanticGeneration(root: string): Promise<{ generation: string; embedded: number; reused: number }> {
    const currentPath = join(root, "CURRENT");
    const generationRoot = join(root, "generations");
    mkdirSync(generationRoot, { recursive: true });
    const generation = `gen-${this.revision().slice(0, 16)}-${Date.now()}`;
    const staging = join(generationRoot, `.${generation}.staging`);
    mkdirSync(staging);
    try {
      const report = await this.indexSemantic();
      const vectors = this.db.prepare(`SELECT v.chunk_id, v.content_hash, v.vector
        FROM semantic_vectors v JOIN chunks c ON c.chunk_id = v.chunk_id
        ORDER BY v.chunk_id`).all();
      writeFileSync(join(staging, "manifest.json"), JSON.stringify({
        archiveRevision: this.revision(), vectors, model: embeddingModelName(),
      }));
      renameSync(staging, join(generationRoot, generation));
      const pointer = join(root, `.CURRENT.${process.pid}`);
      writeFileSync(pointer, `${generation}\n`);
      renameSync(pointer, currentPath);
      return { generation, embedded: report.embedded, reused: report.reused };
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  semanticGeneration(root: string): { generation: string; archiveRevision: string; vectorCount: number } {
    const generation = readFileSync(join(root, "CURRENT"), "utf8").trim();
    const manifest = JSON.parse(readFileSync(join(root, "generations", generation, "manifest.json"), "utf8")) as {
      archiveRevision: string; vectors: unknown[];
    };
    return { generation, archiveRevision: manifest.archiveRevision, vectorCount: manifest.vectors.length };
  }

  async searchSemantic(query: string, filters: SearchFilters = {}, limit = 10): Promise<SearchHit[]> {
    if (!query.trim()) throw new Error("empty query");
    const queryVector = await (await this.getEmbedder()).embedQuery(query);
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
    for (const language of lexicalFields()) this.db.exec(`DELETE FROM chunks_fts_${language}`);
      for (const row of rows) {
        const message = this.db.prepare("SELECT * FROM messages WHERE message_id = ?").get(row.message_id) as MessageRow;
        this.db.prepare(`INSERT INTO chunks_fts(rowid, subject, from_address, to_addresses, thread_subject,
          body_latest, body_quoted, forwarded_text, attachment_text)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.rowid, message.subject, message.from_address,
          message.to_addresses, message.subject, row.text, "", "", message.attachment_text || "");
      }
    });
    rebuild();
    this.db.prepare("DELETE FROM lexical_index_meta WHERE id = 1").run();
    this.lexicalRebuildRequired = true;
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
    this.db.prepare("DELETE FROM semantic_vectors WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE message_id = (SELECT message_id FROM messages WHERE provider_key = ?))").run(message.providerKey);
    this.db.prepare("DELETE FROM messages WHERE provider_key = ?").run(message.providerKey);
  }

  private replaceMessageChunks(message: NormalizedMessage, analyzedChunks?: Map<string, Map<string, string>>): void {
    const old = this.db.prepare("SELECT rowid, chunk_id FROM chunks WHERE message_id = ?").all(message.messageId) as { rowid: number; chunk_id: string }[];
    for (const row of old) this.db.prepare("DELETE FROM chunks_fts WHERE rowid = ?").run(row.rowid);
    for (const language of lexicalFields()) this.db.prepare(`DELETE FROM chunks_fts_${language} WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE message_id = ?)`).run(message.messageId);
    this.db.prepare("DELETE FROM embedding_queue WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE message_id = ?)").run(message.messageId);
    this.db.prepare("DELETE FROM semantic_vectors WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE message_id = ?)").run(message.messageId);
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

  private async getEmbedder(): Promise<Embedder> {
    this.embedder ??= await createEmbedder();
    return this.embedder;
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
  CREATE TABLE IF NOT EXISTS semantic_vectors (
    chunk_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', vector TEXT NOT NULL
  );
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
  const vectorColumns = db.prepare("PRAGMA table_info(semantic_vectors)").all() as Array<{ name: string }>;
  if (!vectorColumns.some((column) => column.name === "model")) db.exec("ALTER TABLE semantic_vectors ADD COLUMN model TEXT NOT NULL DEFAULT ''");
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
  db.prepare(`DELETE FROM semantic_vectors
    WHERE NOT EXISTS (SELECT 1 FROM chunks WHERE chunks.chunk_id = semantic_vectors.chunk_id)`).run();
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
type SemanticRow = Omit<SearchRow, "snippet" | "score"> & { vector: string; text: string };
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
