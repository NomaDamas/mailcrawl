---
name: mailcrawl
description: Search and maintain a local, privacy-first email archive through the mailcrawl CLI.
---

# mailcrawl

Use `mailcrawl` as a local, read-oriented email retrieval tool. It indexes
messages obtained through the configured Himalaya account and returns bounded
JSON suitable for an agent.

## Installation and activation

Install the package and build the CLI from the repository:

```bash
npm install
npm run build
```

Expose `dist/cli/index.js` as `mailcrawl` on `PATH`, or invoke it with
`node dist/cli/index.js`. Agent skill runners should discover this file through
the `skills/mailcrawl/SKILL.md` directory and activate it only when the user
requests local email synchronization or search.

Required runtime dependencies are Node.js 24+, the package dependencies, and
the Himalaya CLI for live synchronization. Fixture synchronization needs no
mail account.

For Korean lexical search, provide a Kiwi model directory through
`MAILCRAWL_KIWI_MODEL`; the WASM binary is bundled by `kiwi-nlp`. Kagome has
no official Node binding, and GSE's referenced `gse-bind` is not available as
a usable npm package. Therefore Japanese and Chinese lexical search use the
repository helpers `tools/mailcrawl-ja` and `tools/mailcrawl-zh`; set
`MAILCRAWL_JA_HELPER` / `MAILCRAWL_ZH_HELPER` when they are not on PATH.
Production multilingual search fails clearly when its analyzer is not
configured; it never silently uses the test tokenizer.

## Data and credential boundaries

The archive lives under `.mailcrawl` by default. Set `--data-dir` or
`MAILCRAWL_DATA_DIR` to choose another local directory. The archive contains
sensitive message metadata and content; keep its permissions private and do
not commit it.

Himalaya resolves credentials. Pass only account, backend, mailbox, and
configuration path options to mailcrawl. Never place passwords, tokens, raw
provider responses, or message bodies in logs, prompts, issue comments, or
diagnostics.

## Workflow

Synchronization is explicit. mailcrawl does not run a background daemon:

```bash
mailcrawl sync --account personal --mailbox INBOX --json
mailcrawl index --json
mailcrawl search --mode hybrid --json "contract renewal"
```

For scheduled operation, configure an external scheduler with an explicit
command, such as a user-level cron or systemd timer. Run `sync` first and
`index` afterward; inspect JSON exit status before handing results to an
agent.

Use a fixture for deterministic development:

```bash
mailcrawl sync --source fixture --fixture ./messages.json --json
```

## Safe read and maintenance commands

Search modes are `fts`, `bm25`, `keyword`, `semantic`, and `hybrid`; `fts` and
`keyword` are aliases for BM25 lexical search. Use metadata
filters such as `--mailbox`, `--from`, `--to`, `--thread`, `--after`, and
`--before`. Empty queries and unsupported modes fail with a non-zero exit.

Navigate from a hit without dumping the entire archive:

```bash
mailcrawl message get MESSAGE_ID --json
mailcrawl thread get THREAD_ID --json
mailcrawl thread-context THREAD_ID --message MESSAGE_ID --json
mailcrawl chunk-context CHUNK_ID --json
mailcrawl attachments list --message MESSAGE_ID --json
```

Check health and rebuild lexical data when needed:

```bash
mailcrawl doctor --json
mailcrawl status --json
mailcrawl embed --json
mailcrawl repair --fts --json
mailcrawl repair --semantic --json
mailcrawl repair --all --json
```

`doctor` reports archive, FTS, and semantic-generation state. `repair` is a
local maintenance operation and should be run only when diagnostics indicate
that the corresponding index is inconsistent.

## JSON contract

Use `--json` for machine-readable output. Search results contain stable
`chunkId`, `messageId`, `threadId`, `accountId`, `mailbox`, `subject`, `from`,
`to`, `date`, `snippet`, `score`, and `mode` fields. Sync returns counts,
`archiveRevision`, and classification exclusion diagnostics. Do not assume
that an omitted result means a remote deletion.

Treat snippets and identifiers as sensitive. Fetch message or thread content
only when it is required to answer the user, and return the smallest useful
excerpt.

## Safety boundary

This skill supports synchronization, indexing, search, inspection, and local
repair only. It does not send, delete, move, or mutate remote email. Never
invoke an external mail-sending command through this skill. If a user asks to
send mail, obtain explicit approval and hand off to a separate, user-visible
mail client workflow.

## Verification

From a checkout, verify installation and invocation with:

```bash
npm install
npm test
npm run typecheck
npm run build
node dist/cli/index.js --help
node dist/cli/index.js doctor --json
```

The help output proves the CLI is callable. `doctor --json` proves that the
agent can inspect a local data directory without opening a remote account.
