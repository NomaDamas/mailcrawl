# Issue #33 — bounded Himalaya read concurrency, retry, and partial progress

## Scope

Fix the page-wide abort described in issue #33. `HimalayaSource` must stop
fanning out one `himalaya message read` process per envelope, must retry
transient read failures with bounded backoff, must sync the messages it could
read while recording the rest, must surface himalaya's stderr, and must expose
an opt-in `--concurrency <n>` that is independent of the `--page-size` envelope
window.

Success criteria, scenarios, and the stop condition are registered in the
session goal; the durable notepad holds the running plan, findings, and
evidence log.

## Execution order

1. Write the POSIX stub-`himalaya` test that reproduces the throttle abort
   through the real `execFile` + PATH spawn path (criterion 1) and capture RED
   against the current build.
2. Implement the bounded pool and the `HimalayaReadOptions` seam in
   `src/source.ts`; capture GREEN; mutation-proof the in-process bound test.
3. Add the retry/backoff test, capture RED, implement round-based retry with
   exponential backoff, capture GREEN and the mutation proof (criterion 2).
4. Add the partial-progress test (`messages` + `failures[]`, stderr preserved)
   and the CLI end-to-end tests (`--concurrency`, `failures[]`, nothing-read
   exit rule), capture RED, implement `collect()`, the CLI flag, the JSON
   `failures[]`, and the exit rule (criteria 3-4).
5. Document `--concurrency`, the `--page-size` envelope window, and
   `failures[]` in `README.md` and `docs/architecture.md`.
6. Run `npm run typecheck`, `npm run build`, `npm test`, `npm run
   validate:skill`, then the real-account Gmail run (criterion 5), tear down
   every QA artifact with a recorded receipt, self-review the diff, commit per
   increment, push, and open the PR closing #33.

## Delegation

Work stays with the lead: `src/source.ts`, `src/types.ts`, and
`src/cli/index.ts` share one interface change and must be edited in dependency
order, so there are no disjoint write scopes to parallelize. This is a bare
`ulw` run with no `ulw-plan` plan for this work, so the verification gate does
not trigger; a self-review over the full diff is recorded in the notepad
instead of a reviewer child.
