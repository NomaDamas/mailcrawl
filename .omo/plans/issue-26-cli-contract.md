# Issue 26 CLI contract

## Scope

Restore the documented CLI surface without changing archive storage semantics:

- Add `status --json` with archive/FTS/embedding health counts.
- Add `embed --json` as the documented alias for semantic indexing.
- Accept `repair --all --json`, rebuilding FTS and embedding state through the
  existing repair/index operations.
- Accept `search --mode fts`, mapping it to the existing BM25 implementation.
- Keep existing `index`, `search:bm25`, and `repair --fts` behavior intact.

## Verification

1. Add CLI regression tests that fail on the current command surface.
2. Implement the smallest CLI and Archive API additions.
3. Run focused tests, typecheck, build, and the complete test suite.
4. Run every documented command against a real fixture on macOS and capture
   stdout/stderr/exit status.
5. Run the same commands with Windows-style path semantics where supported by
   the host, and document native-Windows limitations explicitly.
6. Review, commit, push, and create a PR.
