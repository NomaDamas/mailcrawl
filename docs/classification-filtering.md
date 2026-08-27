# Classification filtering

mailcrawl preserves provider classification metadata while applying an indexing
policy at sync time. The default policy excludes `spam` and `promotions` from
the local archive, FTS5/BM25, and semantic indexes.

Classification values are normalized case-insensitively. Provider prefixes such
as `CATEGORY_` and `LABEL_` are removed, so `CATEGORY_SPAM`, `spam`, and
`label-spam` all map to `spam`. Values from `classifications`, `labels`, and
`flags` are considered.

## CLI policy

The default is equivalent to:

```bash
mailcrawl sync --exclude-category spam --exclude-category promotions --json
```

Use `--include-category` to opt into a normally excluded category:

```bash
mailcrawl sync --include-category spam --json
```

Use one or more `--exclude-category` options to replace the default exclusion
set. An empty exclusion set can be supplied through the library API:

```ts
await archive.sync(messages, { excludedCategories: [] });
```

Excluded messages are not treated as remote deletions. They are omitted from
the local indexing source of truth for that sync and are reported separately:

```json
{
  "excluded": 2,
  "excludedByReason": {
    "spam": 1,
    "promotions": 1
  }
}
```

If a later sync changes a message's classification so that it is no longer
excluded, the message is indexed normally. This makes classification changes
safe for incremental sync.
