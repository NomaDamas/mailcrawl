# mailcrawl

Local, privacy-first email indexing CLI for AI agents and humans.

mailcrawl uses the configured [Himalaya](https://github.com/pimalaya/himalaya)
account as its mail transport, then maintains a local normalized archive with
incremental synchronization, email-aware chunking, full-text search (FTS5),
semantic vector search, and hybrid retrieval.

> Status: first functional release candidate. Use the installation guide for
> multilingual analyzer setup before indexing production mail.

## Product goal

Make one local command useful to any client:

```bash
mailcrawl sync --json
mailcrawl embed --json
mailcrawl search --mode hybrid --json "계약 갱신 조건"
mailcrawl status --json
mailcrawl doctor --json
mailcrawl repair --all --json
```

The CLI owns email synchronization and indexes. Consumers such as AutoRAG,
OpenClaw, MCP servers, Raycast, and custom scripts consume its stable JSON
surface instead of opening the archive database.

## Capabilities

- Himalaya-backed IMAP/JMAP/Gmail/Microsoft Graph/Maildir access
- `.eml` files and `.mbox`/`.mbx` archives on disk (Gmail Takeout, Thunderbird,
  Apple Mail exports) with no mail account or Himalaya install
- Stable account/mailbox/message identity and cursor state
- MIME normalization, HTML-to-text conversion, and quoted-reply handling
- Email-aware, thread-aware chunking
- Incremental archive, FTS5, and embedding updates
- In-process native embeddings (`Qwen/Qwen3-Embedding-0.6B` via ONNX Runtime, WebGPU/Metal on Apple Silicon with CPU fallback) stored in LanceDB
- FTS, semantic, and hybrid search modes
- JSON output, bounded diagnostics, `status`, `doctor`, and `repair`
- No credential values in logs, diagnostics, or indexed metadata by default

See [`docs/architecture.md`](docs/architecture.md) for the data model and CLI
contract. Lexical analyzer changes invalidate language-specific FTS fields;
run `mailcrawl sync` to rebuild them before multilingual search. Semantic
embedder changes require `mailcrawl index` to rebuild the vector table.

When a lexical analyzer or its model changes, the stored analyzer fingerprint
invalidates all language-specific FTS fields. Run a complete `mailcrawl sync`
before multilingual search; the command re-analyzes existing messages and
atomically records the new fingerprint. Embedding model changes are independent
and require `mailcrawl index` to rebuild the vector table.

## Sync read concurrency

`mailcrawl sync` reads a page of envelopes through a bounded pool of himalaya
processes — 4 by default, `--concurrency <n>` to change it — instead of
spawning one process per envelope. Gmail throttles accounts that open too many
simultaneous IMAP connections, and an unbounded fan-out made one throttled
read abort the entire sync. `--page-size` still controls only how many
envelopes the IMAP window returns.

A read that fails is retried with exponential backoff (three attempts by
default). Messages that stay unreadable are reported in the sync JSON as
`failures[]` with their `providerKey`, `attempts`, and the redacted himalaya
error, while the messages that could be read are still synced. The command
exits non-zero only when nothing could be read.

## Files source: `.eml` and `.mbox` on disk

`--source files` indexes mailbox backups without a mail account or Himalaya:

```bash
mailcrawl sync --source files --path ~/Mail/backup.mbox --account takeout --json
mailcrawl sync --source files --path ~/Mail/eml-dir/ --json   # recursive
```

- `--path` is repeatable and accepts `.eml` files, `.mbox`/`.mbx` archives
  (mboxo and mboxrd), and directories, which are walked recursively.
  Maildir directories are not read directly; use Himalaya's Maildir backend.
- `--account` is optional and defaults to the first `--path` name. The mailbox
  is the mbox file name, or the name of the directory holding an `.eml`;
  `--mailbox` overrides both.
- Identity: a message is keyed by its `Message-ID` header, or by the SHA-256 of
  its raw bytes when the header is missing. The same message found in several
  files of one mailbox is indexed once and listed in `duplicates[]`.
- Incremental: per-file size and mtime are stored in the archive, so a re-sync
  with no changes reads nothing. A changed mbox is re-read and reconciled by
  identity: appending one message adds exactly that message.
- Deletion: a message is deleted when the last file (or mbox entry) holding
  it disappears. An mbox entry that newly fails to parse never deletes the
  message it may have been, and a file that cannot be read keeps its messages
  and is retried on the next sync.
- Limits: messages over 50 MiB are skipped, body text is capped at 1,000,000
  characters, and text attachments over 1 MB keep only their metadata.
- Failures: unparseable messages are reported in `failures[]` and the rest are
  indexed; failures of unchanged files are re-reported on later syncs. Files
  appear in diagnostics as `<path name>/<relative path>[#entry]`, never by
  absolute path. Gmail `X-Gmail-Labels` become labels, so the default
  spam/promotions exclusion applies to Takeout archives.

The JSON adds `account`, `files` (mail files found), `filesRead` (files
re-read because they changed), and `duplicates` to the usual sync counts.

## Installation

For the required Node setup, Kiwi model files, Go installation, Japanese and
Chinese helper builds, environment variables, smoke tests, and license
requirements, follow [`docs/multilingual-installation.md`](docs/multilingual-installation.md)
before using multilingual indexing or search.

## Semantic index

The default semantic path is fully in-process: no HTTP sidecar, no gateway.
Vectors live in a LanceDB table at `<data-dir>/semantic.lance` (a typed
`Float32` vector column, SQL predicate pushdown for account/mailbox and date
filters) while SQLite stays the source of truth for messages, chunks, and
FTS. Indexing pages chunks in small batches (`--batch-size`, default 4 for
the native profile, mirroring MinSync) and commits each batch — vector
upsert plus queue completion — so a crash resumes from the last committed
batch instead of restarting from zero.

The active embedder identity (provider, model, dimension, prefixes, runtime
build) is persisted next to the table in
`<data-dir>/semantic.identity.json`. Identity is data: a mismatch on the next
`mailcrawl index` discards the vector table and re-embeds everything, never
silently reusing vectors from a different embedding space. Semantic search
against a mismatched table fails loudly with a rebuild hint instead of
returning garbage scores. `mailcrawl repair --semantic` forces a full rebuild.

### Embedding providers

- `native` (default): in-process `Qwen/Qwen3-Embedding-0.6B` (1024-d) through
  ONNX Runtime's native binding — WebGPU (Metal on Apple Silicon) with
  automatic CPU fallback. Configure with `--model`, `--device` (`auto`, `cpu`,
  `webgpu`, `metal`), `--dtype` (default `q4f16` on WebGPU), and
  `--batch-size`.
- `legacy-onnx`: the pre-0.2 EmbeddingGemma profile on CPU, kept for archives
  that must keep their old vector space. On the first index run this profile
  imports compatible legacy JSON vectors instead of re-embedding them.
- `loopback-http`: an explicit opt-in for operators who already run a shared
  embedding gateway (#31). Only HTTP URLs for `127.0.0.1`, `localhost`, or
  `::1` are accepted. Requires `--embed-url`, `--embed-model`, and
  `--embed-dim`; query/passage prefixes and timeout are optional and are
  included in the provider identity.

The equivalent environment contract is `MAILCRAWL_EMBEDDER_PROVIDER`
(`native`, `legacy-onnx`, or `loopback-http`), `MAILCRAWL_NATIVE_MODEL`,
`MAILCRAWL_NATIVE_DEVICE`, `MAILCRAWL_NATIVE_DTYPE`,
`MAILCRAWL_EMBED_BATCH_SIZE`, plus the loopback variables
`MAILCRAWL_EMBED_URL`, `MAILCRAWL_EMBED_MODEL`, `MAILCRAWL_EMBED_DIM`,
`MAILCRAWL_QUERY_PREFIX`, `MAILCRAWL_PASSAGE_PREFIX`, and
`MAILCRAWL_EMBED_TIMEOUT`. Any provider identity change triggers a full
vector rebuild on the next index run.

## Releasing

GitHub Release `vX.Y.Z` (must match `package.json`) publishes `@nomadamas/mailcrawl` to npm with OIDC trusted publishing. No `NPM_TOKEN` is stored in GitHub.

One-time setup:

1. Create a GitHub Environment named `release` on this repository.
2. On [npm trusted publishers](https://docs.npmjs.com/trusted-publishers) for `@nomadamas/mailcrawl`, add GitHub Actions:
   - Organization: `NomaDamas`
   - Repository: `mailcrawl`
   - Workflow filename: `release.yml`
   - Environment: `release`

Then bump the version, push `main`, and publish a GitHub Release whose tag is
`v<version>`. The workflow tests, builds, publishes with OIDC, and attaches the
tarball to the release. Public npm provenance is unavailable while this source
repository remains private.

## License

MIT. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for runtime
component licenses.
