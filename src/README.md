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
