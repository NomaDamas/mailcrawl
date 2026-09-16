# Issue #31 — loopback HTTP embedding provider

## Scope

Implement the opt-in loopback HTTP embedding provider contract from issue #31.
The provider must accept only loopback URLs, send embedding text without
archive identifiers or metadata, expose model/dimension/prefix/timeout
configuration through the existing archive and CLI paths, preserve atomic
semantic generation publication on failure, and record provider identity in
the manifest.

## Execution order

1. Locate test conventions and archive embedder plumbing.
2. Add failing tests for URL validation, request payload privacy, manifest
   identity, and failed-generation atomicity.
3. Implement types, loopback HTTP embedder, archive configuration plumbing, and
   CLI flags.
4. Run targeted tests and diagnostics.
5. Run the CLI against a local test HTTP server and capture request/response
   evidence.
6. Run full tests/build, inspect diff and history, commit, push, and open PR.

## Delegation

Work stays with the lead because embedding, archive, and CLI changes share
interfaces and must be implemented in dependency order. One final gate review
may run independently after the verified diff exists.
