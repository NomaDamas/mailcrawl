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
