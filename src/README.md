# Source layout

The directories below are reserved for the documented implementation
boundaries. They intentionally contain no runtime code yet.

- `cli/` - command parsing and JSON output
- `archive/` - SQLite schema, migrations, and source-of-truth metadata
- `sync/` - Himalaya synchronization and cursor handling
- `mime/` - MIME parsing and text normalization
- `chunking/` - email/thread-aware chunk construction
- `fts/` - SQLite FTS5/BM25 indexing and search
- `embedding/` - provider adapters and durable embedding queue
- `vector/` - LanceDB tables and vector lifecycle
- `hybrid/` - deterministic lexical/semantic fusion
- `diagnostics/` - bounded, redacted operational errors

## Multilingual lexical analyzers

Production Korean indexing uses the real `kiwi-nlp` WASM binding. The binary
defaults to the installed package. Set `MAILCRAWL_KIWI_MODEL` to a matching
Kiwi model directory containing:

```text
combiningRule.txt default.dict extract.mdl multi.dict
sj.knlm sj.morph skipbigram.mdl typo.dict
```

Japanese and Chinese use the real Kagome and GSE analyzers from the discrawl
multilingual design. Build the persistent helpers:

```bash
(cd tools/mailcrawl-ja && go build -o ~/.local/bin/mailcrawl-ja .)
(cd tools/mailcrawl-zh && go build -o ~/.local/bin/mailcrawl-zh .)
```

Set `MAILCRAWL_JA_HELPER` and `MAILCRAWL_ZH_HELPER` when they are not on PATH.
Arabic uses the in-process light stemmer from that design. Missing production
analyzers fail clearly; only `NODE_ENV=test` uses the test tokenizer.
