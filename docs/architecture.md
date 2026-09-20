# mailcrawl architecture

## Decision

mailcrawl is an independent CLI and local indexing service. AutoRAG should
integrate with it through a thin process adapter, in the same way it
integrates with `katok`, `discrawl`, and `qmd`.

The boundary is intentional:

```text
Himalaya
  -> mailcrawl sync/archive/chunk/FTS/vector
  -> stable JSON CLI contract
  -> AutoRAG datasource adapter
  -> datasource authorization and agent retrieval
```

mailcrawl must remain useful without AutoRAG. AutoRAG must not read the
mailcrawl database directly.

## Responsibilities

### mailcrawl owns

- Provider synchronization through Himalaya
- Account, mailbox, message, and thread identity
- Raw/normalized message archive
- MIME parsing and text normalization
- Email-aware chunking
- SQLite metadata and FTS5/BM25 index
- Embedding queue and model identity
- LanceDB vector index
- FTS, semantic, and hybrid ranking
- Schema migrations, repair, compaction, and health checks
- Stable JSON output and bounded, redacted diagnostics

### Consumers own

- Authentication policy and trusted configuration handoff
- Scheduling and polling
- Access control and scope filtering
- Mapping results into their own retrieval contracts
- LLM answering and cross-source result merging

## Storage layout

The initial implementation should use two stores, with explicit
reconciliation:

```text
<workspace>/
  archive.sqlite
    accounts
    mailboxes
    messages
    threads
    chunks
    sync_cursors
    embedding_queue
    chunks_fts (FTS5)
  vectors/
    LanceDB tables keyed by chunk_id and embedding_model
  semantic.lance/           # LanceDB vector table (rebuildable)
  semantic.identity.json    # embedder identity persisted next to the table
```

SQLite is the source of truth for message/chunk metadata, synchronization
state, and lexical search. LanceDB is a rebuildable semantic index. FTS must
remain available when embeddings are unavailable or stale.

## Synchronization model

The first version uses a safe snapshot-diff algorithm:

1. Ask Himalaya for bounded envelope pages.
2. Normalize each envelope into a stable account/mailbox/message key.
3. Compare provider identity plus envelope fingerprint with local state.
4. Fetch full MIME content only for new or changed messages.
5. Mark absent messages deleted only when the complete mailbox snapshot is
   known; never infer deletion from a truncated page.
6. Normalize and chunk changed messages.
7. Transactionally update SQLite metadata and FTS5.
8. Enqueue changed chunks for embedding.

Later provider-specific cursors can improve scale without changing the public
contract:

- IMAP UIDVALIDITY + UID, with MODSEQ/QRESYNC where available
- Gmail history ID
- JMAP state token
- Microsoft Graph delta link
- Maildir file identity and mtime

## Email-aware chunking

Naive fixed-size slicing is not sufficient for email. The normalizer should
separate:

```text
message
  headers
  latest authored text
  quoted reply history
  forwarded content
  signature
  attachments and extracted text
```

The first chunking policy should:

- preserve subject/from/to/date metadata with every searchable chunk
- prefer paragraph and reply-boundary cuts
- remove repeated quoted history when safe
- keep a stable `chunk_id` derived from message identity, section, and index
- retain a link from every chunk to its source message and thread
- version the normalization/chunking policy for controlled reindexing

## Search model

### FTS5/BM25

SQLite FTS5 indexes subject, addresses, normalized body, thread subject, and
attachment text. Field weighting should favor subject and sender matches.
Search results return stable chunk and message identifiers.

### Semantic

Only normalized, non-empty chunks enter the embedding queue. Vectors live in
a LanceDB table at `<data-dir>/semantic.lance` — a typed
`FixedSizeList<Float32>` vector column with account/mailbox/thread/date
predicate columns — not as JSON text in SQLite. SQLite stays the source of
truth for messages, chunks, and FTS; the Lance table is a rebuildable semantic
index. Account, mailbox, thread, sender, and date filters are pushed down as
Lance SQL predicates; the `to` filter is applied during SQLite hydration.

The embedder identity (provider, model, dimension, prefixes, runtime build)
is persisted next to the table in `<data-dir>/semantic.identity.json`.
Identity is data: a mismatch discards the vector table and re-embeds
everything on the next index run, and search against a mismatched table fails
loudly instead of silently scoring across embedding spaces.

Indexing pages chunks in small configurable batches and commits each batch
(vector upsert plus queue completion), so a crash resumes from the queue
instead of restarting from zero. A failed embedding job must not make FTS
unavailable.

The default embedder is the in-process native profile —
`native:Qwen/Qwen3-Embedding-0.6B` (1024-d) through ONNX Runtime's native
Node binding, WebGPU (Metal) on Apple Silicon with CPU fallback, batched —
matching the MinSync local retriever contract: no HTTP sidecar, no gateway
process. EmbeddingGemma remains as the `legacy-onnx` opt-in profile, and
`loopback-http` stays an explicit opt-in override for shared gateways.

### Hybrid

Run lexical and semantic retrieval independently, normalize scores, dedupe by
chunk/message policy, and merge with a deterministic weighted rank. If the
vector index is missing or stale, hybrid falls back to FTS and reports a
bounded warning in JSON diagnostics.

## CLI contract

All commands support `--json` where machine-readable output is useful.

```text
mailcrawl doctor
mailcrawl status
mailcrawl sync [--page-size N] [--concurrency N]
mailcrawl embed
mailcrawl search --mode fts|bm25|keyword|semantic|hybrid [--limit N] [--mailbox NAME] QUERY
mailcrawl message get MESSAGE_ID
mailcrawl repair [--fts|--semantic|--all]
```

`--page-size` is the IMAP envelope window and `--concurrency` is the number of
simultaneous message reads (default 4). Reads run through that bounded pool,
failures are retried with backoff, and the messages that could be read are
synced even when some reads keep failing, so a throttled provider no longer
aborts a whole page.

Example sync response:

```json
{
  "added": 12,
  "updated": 3,
  "deleted": 1,
  "unchanged": 4821,
  "chunksAdded": 21,
  "chunksDeleted": 6,
  "embeddingBacklog": 21,
  "failures": []
}
```

Each entry of `failures` carries the `providerKey`, the `attempts` spent on it,
and the redacted himalaya error (including himalaya's own stderr). The command
exits non-zero only when nothing could be read.

Example search hit:

```json
{
  "chunkId": "msg-123:latest:0",
  "messageId": "msg-123",
  "threadId": "thread-42",
  "score": 0.87,
  "content": "계약 갱신 조건은...",
  "subject": "Re: 2026 계약 갱신",
  "mailbox": "INBOX"
}
```

## Security and privacy

- Himalaya remains responsible for credential resolution.
- mailcrawl passes only configured account/backend/mailbox values.
- Secrets never enter archive metadata or diagnostics.
- Diagnostics are bounded and redact common email/path/secret patterns.
- Local embeddings are the default recommendation.
- Remote embedding providers require explicit configuration.
- The archive is local and must be treated as sensitive data.

## Implementation milestones

1. Define schema, CLI JSON schemas, and fake Himalaya runner.
2. Implement Himalaya doctor/account validation and snapshot sync.
3. Implement MIME normalization and email-aware chunking.
4. Implement SQLite metadata plus FTS5/BM25 search.
5. Add the AutoRAG adapter and verify end-to-end lexical retrieval.
6. Add embedding providers, queue draining, and LanceDB storage.
7. Add semantic and hybrid retrieval with deterministic fallback.
8. Add provider-native cursors, repair, benchmarks, and release packaging.

## Non-goals for the first release

- Sending, deleting, or mutating remote mail
- Replacing Himalaya's mail client surface
- Cloud-hosted indexing
- Automatic remote embedding without opt-in
- LLM-generated summaries as part of the storage engine
