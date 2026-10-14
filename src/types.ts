export type SearchMode = "keyword" | "bm25" | "semantic" | "hybrid";

export type EmbedderProvider = "native" | "legacy-onnx" | "loopback-http" | "mock";

/** Quantization for the in-process native embedder (ONNX Runtime). */
export type NativeDtype = "fp32" | "fp16" | "q8" | "int8" | "q4" | "q4f16" | "uint8";

/**
 * In-process native embedder (issue #39): no HTTP sidecar, batched inference,
 * GPU (WebGPU/Metal on Apple Silicon) with CPU fallback. Mirrors the MinSync
 * `native:Qwen/Qwen3-Embedding-0.6B` profile.
 */
export interface NativeEmbedderConfig {
  provider: "native";
  /** Registry id, e.g. `Qwen/Qwen3-Embedding-0.6B`. */
  model: string;
  dimension: number;
  /** "auto" resolves WebGPU first and falls back to CPU; "metal" is an alias for "webgpu". */
  device: "auto" | "cpu" | "webgpu";
  dtype: NativeDtype;
  /** Number of texts per inference batch (MinSync uses 4 for native Metal). */
  batchSize: number;
  queryPrefix?: string;
  passagePrefix?: string;
}

/** Legacy opt-in profile: Transformers.js EmbeddingGemma on CPU (pre-#39 default). */
export interface LegacyOnnxConfig {
  provider: "legacy-onnx";
  batchSize?: number;
}

export interface MockEmbedderConfig {
  provider: "mock";
  batchSize?: number;
}

export interface LoopbackHttpConfig {
  provider: "loopback-http";
  url: string;
  model: string;
  dimension: number;
  queryPrefix?: string;
  passagePrefix?: string;
  timeoutMs?: number;
  batchSize?: number;
}

export type EmbedderConfig = NativeEmbedderConfig | LegacyOnnxConfig | LoopbackHttpConfig | MockEmbedderConfig;

/**
 * Embedder identity persisted next to the semantic vector table (issue #39:
 * "identity is data"). A mismatch requires a full rebuild, never silent reuse.
 * `runtimeBuild` and `indexedRevision` are informational and excluded from
 * identity comparison.
 */
export interface EmbedderIdentity {
  provider: string;
  model: string;
  dimension: number;
  queryPrefix?: string;
  passagePrefix?: string;
  runtimeBuild: string;
  /** Archive revision at the last fully completed index run. */
  indexedRevision?: string;
}

export interface MailMessage {
  accountId: string;
  mailbox: string;
  providerKey: string;
  messageId?: string;
  threadId?: string;
  inReplyTo?: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  date: string;
  text: string;
  html?: string;
  rawMime?: string;
  attachments?: AttachmentInput[];
  labels?: string[];
  flags?: string[];
  classifications?: string[];
}

export interface AttachmentInput {
  name: string;
  mimeType: string;
  size?: number;
  text?: string;
  contentHash?: string;
}

export interface NormalizedMessage extends MailMessage {
  messageId: string;
  threadId: string;
  normalizedSubject: string;
  latestText: string;
  quotedText: string;
  normalizedHash: string;
  categories: string[];
}

export interface Chunk {
  chunkId: string;
  accountId: string;
  mailbox: string;
  messageId: string;
  threadId: string;
  section: string;
  ordinal: number;
  text: string;
  startedAt: string;
  endedAt: string;
  contentHash: string;
}

export interface SearchFilters {
  accountId?: string;
  mailbox?: string;
  from?: string;
  to?: string;
  threadId?: string;
  after?: string;
  before?: string;
}

export interface SearchHit {
  chunkId: string;
  messageId: string;
  threadId: string;
  accountId: string;
  mailbox: string;
  subject: string;
  from: string;
  to: string[];
  date: string;
  snippet: string;
  score: number;
  mode: SearchMode;
}

export type LexicalLanguage = "ko" | "ja" | "zh" | "ar";

export interface SyncReport {
  added: number;
  updated: number;
  deleted: number;
  unchanged: number;
  touchedThreads: number;
  rebuiltThreads: number;
  chunksAdded: number;
  chunksDeleted: number;
  embeddingBacklog: number;
  archiveRevision: string;
  excluded: number;
  excludedByReason: Record<string, number>;
}

export interface SourceReadFailure {
  providerKey: string;
  attempts: number;
  error: string;
}

export interface SourceReadResult {
  messages: MailMessage[];
  failures: SourceReadFailure[];
}

export interface ClassificationPolicy {
  excludedCategories?: string[];
}

/** Stored change-detection state for one file under one files-source root. */
export interface SourceFileState {
  size: number;
  mtimeMs: number;
  /** Per-message failures from the last read; re-reported while the file is unchanged. */
  failures: SourceReadFailure[];
  /** Content keys of the mbox entries that failed to parse in the last read. */
  failedEntries: string[];
}

/** Per-file outcome of one files-source scan. */
export interface SourceFileSnapshot {
  rootKey: string;
  relPath: string;
  size: number;
  mtimeMs: number;
  /** False when size and mtime match the stored state; the file was not re-read. */
  changed: boolean;
  /**
   * `complete`: every message was read, or the only failures are mbox entries
   * that already failed with the same bytes; the file's message set is
   * replaced. `partial`: an mbox entry newly failed to parse. The archive
   * replaces the set only when no previously held message is missing from
   * this read; otherwise the broken entry may be that message, so nothing is
   * removed until the entry is fixed or deleted. `unreadable`: the file could
   * not be read or is not an mbox; nothing is removed and no state is stored,
   * so the next sync retries it.
   */
  status: "complete" | "partial" | "unreadable";
  /** Unscoped provider keys of every message read from this file, duplicates included. */
  messages: Array<{ mailbox: string; providerKey: string }>;
  /** Failures from this read, or the stored ones re-reported for an unchanged file. */
  failures: SourceReadFailure[];
  /** Content keys of the mbox entries that failed to parse in this read. */
  failedEntries: string[];
}

/** A directory or file under a root that could not be listed or stat'ed; stored files at or below it are not treated as removed. */
export interface UnlistedPath {
  rootKey: string;
  /** Root-relative path; `""` is the root itself. */
  relPath: string;
}

/**
 * Complete snapshot of one files sync. When `authoritative` (an explicit
 * `--account`), stored roots of `accountId` that are not in `rootKeys` (a
 * dropped `--path`, a moved root, a changed `--mailbox`) are released, but
 * only after a sync with no unsafe read.
 */
export interface FilesSnapshot {
  accountId: string;
  /** True only for an explicit account; a derived account never releases other roots. */
  authoritative: boolean;
  /** Every stored file under these roots that is absent from `files` was removed from disk. */
  rootKeys: string[];
  files: SourceFileSnapshot[];
  unlisted: UnlistedPath[];
}

export interface SyncOptions extends ClassificationPolicy {
  /** Files-source snapshot: reconciles per-file state and deletes messages whose files or mbox entries disappeared. */
  files?: FilesSnapshot;
}
