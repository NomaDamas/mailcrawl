export type SearchMode = "keyword" | "bm25" | "semantic" | "hybrid";

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
}
