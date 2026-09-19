#!/usr/bin/env node
// Test double for the himalaya CLI (tests/issue-33-read-concurrency.test.ts).
//
// It emulates the Gmail account-level simultaneous-connection cap documented in
// issue #33: a message read that observes more concurrent reads than
// MC_STUB_LIMIT fails the way a throttled IMAP fetch does. Every configuration
// is read from the environment so one fixture covers the pool, retry, and
// partial-progress scenarios.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const stateDir = process.env.MC_STUB_DIR ?? ".";
const limit = Number(process.env.MC_STUB_LIMIT ?? 4);
const envelopeCount = Number(process.env.MC_STUB_COUNT ?? 12);
const readDelayMs = Number(process.env.MC_STUB_READ_DELAY_MS ?? 250);
const failMessage = process.env.MC_STUB_FAIL_MESSAGE ?? "FETCH returned no body for the requested message";
const alwaysFailing = new Set((process.env.MC_STUB_FAIL_ALWAYS ?? "").split(",").filter(Boolean));
const failOnce = (process.env.MC_STUB_FAIL_ONCE ?? "")
  .split(",")
  .filter(Boolean)
  .map((value) => value.split(":"))
  .filter((pair) => pair.length === 2);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const record = (file, line) => appendFileSync(join(stateDir, file), `${line}\n`);
const bumpAttempts = (id) => {
  const file = join(stateDir, "attempts", id);
  mkdirSync(dirname(file), { recursive: true });
  const next = (existsSync(file) ? Number(readFileSync(file, "utf8")) : 0) + 1;
  writeFileSync(file, String(next));
  return next;
};

if (args.includes("envelope") && args.includes("list")) {
  const envelopes = Array.from({ length: envelopeCount }, (_, index) => ({
    id: String(index + 1),
    "message-id": `m${index + 1}@example.test`,
    subject: `Subject ${index + 1}`,
    from: "sender@example.test",
    to: ["recipient@example.test"],
    date: "2026-08-26T00:00:00Z",
    body: `body ${index + 1}`,
  }));
  process.stdout.write(JSON.stringify({ envelopes }));
  process.exit(0);
}

const id = args[args.indexOf("read") + 1];
const slotDir = join(stateDir, "active");
mkdirSync(slotDir, { recursive: true });
const slot = join(slotDir, `${process.pid}-${Date.now()}`);
writeFileSync(slot, "");
await sleep(readDelayMs);
const observed = readdirSync(slotDir).length;
const attempt = bumpAttempts(id);
record("observed.log", `${id} ${observed}`);
record("attempts.log", `${id} ${attempt}`);
rmSync(slot, { force: true });

if (observed > limit) {
  record("throttled.log", `${id} ${observed}`);
  process.stderr.write(`${failMessage}: Too many simultaneous connections\n`);
  process.exit(1);
}
if (alwaysFailing.has(id) || failOnce.some(([key, count]) => key === id && attempt <= Number(count))) {
  process.stderr.write(`${failMessage}\n`);
  process.exit(1);
}

await sleep(50);
process.stdout.write(JSON.stringify({ message: `raw mime ${id}` }));
