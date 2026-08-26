# Contributing

## Commit convention

Every commit uses:

```text
<type>(<scope>): <imperative summary>
```

Allowed types are `feat`, `fix`, `test`, `refactor`, `perf`, `docs`, `chore`,
and `build`. The subject is written in English, starts with a lower-case
imperative verb, and stays under 72 characters. Each commit contains one
coherent verified increment; tests belong in the same commit as the behavior
they protect. Do not commit credentials, real mail, local archives, generated
vectors, or provider responses.

Examples:

```text
test(archive): cover idempotent envelope sync
feat(search): add literal FTS5 BM25 retrieval
fix(index): preserve current generation on failure
```

## Verification before commit

Run the narrowest relevant test first, then:

```bash
npm test
npm run typecheck
npm run build
```

Commits are pushed only after their own checks pass. Real-account fixtures and
sanitized command summaries may be recorded in notes, but message bodies,
addresses, credentials, and raw provider output must not be committed.
