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
defaults to the installed package. The matching Kiwi model is downloaded to
the local cache on first Korean use. Set `MAILCRAWL_KIWI_MODEL` to override
with a matching Kiwi model directory containing:

For current Kiwi releases, use the complete model variant directory described
in `docs/multilingual-installation.md`; do not mix model and WASM versions.

Semantic indexing uses the in-process native embedder —
`Qwen/Qwen3-Embedding-0.6B` via ONNX Runtime's native binding (WebGPU/Metal
on Apple Silicon, CPU fallback) — and stores vectors in a LanceDB table at
`<data-dir>/semantic.lance`. The model is downloaded to the local cache on
first use. `EmbeddingGemma` remains available as the `legacy-onnx` opt-in
profile, and `loopback-http` stays an explicit override (#31). The embedder
identity persisted at `<data-dir>/semantic.identity.json` governs reuse: a
mismatch forces a full rebuild, never silent reuse.

Japanese and Chinese use the real Kagome and GSE analyzers from the discrawl
multilingual design. Neither analyzer currently has a usable official Node
binding, so build the persistent Go helpers:

```bash
(cd tools/mailcrawl-ja && go build -o ~/.local/bin/mailcrawl-ja .)
(cd tools/mailcrawl-zh && go build -o ~/.local/bin/mailcrawl-zh .)
```

Set `MAILCRAWL_JA_HELPER` and `MAILCRAWL_ZH_HELPER` when they are not on PATH.
Arabic uses the in-process light stemmer from that design. Missing production
analyzers fail clearly; only `NODE_ENV=test` uses the test tokenizer.
