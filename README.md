# mailcrawl

Local, privacy-first email indexing CLI for AI agents and humans.

mailcrawl uses the configured [Himalaya](https://github.com/pimalaya/himalaya)
account as its mail transport, then maintains a local normalized archive with
incremental synchronization, email-aware chunking, full-text search (FTS5),
semantic vector search, and hybrid retrieval.

> Status: concept scaffold. The architecture is documented before the first
> implementation increment.

## Product goal

Make one local command useful to any client:

```bash
mailcrawl sync --json
mailcrawl embed --json
mailcrawl search --mode hybrid --json "계약 갱신 조건"
mailcrawl status --json
mailcrawl doctor --json
```

The CLI owns email synchronization and indexes. Consumers such as AutoRAG,
OpenClaw, MCP servers, Raycast, and custom scripts consume its stable JSON
surface instead of opening the archive database.

## Planned capabilities

- Himalaya-backed IMAP/JMAP/Gmail/Microsoft Graph/Maildir access
- Stable account/mailbox/message identity and cursor state
- MIME normalization, HTML-to-text conversion, and quoted-reply handling
- Email-aware, thread-aware chunking
- Incremental archive, FTS5, and embedding updates
- LanceDB vector storage with configurable local embedding providers
- FTS, semantic, and hybrid search modes
- JSON output, bounded diagnostics, `status`, `doctor`, and `repair`
- No credential values in logs, diagnostics, or indexed metadata by default

See [`docs/architecture.md`](docs/architecture.md) for the proposed design,
data model, CLI contract, and implementation milestones.

## Installation

For the required Node setup, Kiwi model files, Go installation, Japanese and
Chinese helper builds, environment variables, smoke tests, and license
requirements, follow [`docs/multilingual-installation.md`](docs/multilingual-installation.md)
before using multilingual indexing or search.

## Releasing

GitHub Release `vX.Y.Z` (must match `package.json`) publishes `@nomadamas/mailcrawl` to npm with OIDC trusted publishing. No `NPM_TOKEN` is stored in GitHub.

One-time setup:

1. Create a GitHub Environment named `release` on this repository.
2. On [npm trusted publishers](https://docs.npmjs.com/trusted-publishers) for `@nomadamas/mailcrawl`, add GitHub Actions:
   - Organization: `NomaDamas`
   - Repository: `mailcrawl`
   - Workflow filename: `release.yml`
   - Environment: `release`

Then bump the version, push `main`, and publish a GitHub Release whose tag is `v<version>`. The workflow tests, builds, publishes with provenance, and attaches the tarball to the release.

## License

MIT. This project is not yet a production release.
