import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { HimalayaSource, mapWithConcurrency } from "../src/source.js";

const STUB_SOURCE = join("tests", "fixtures", "himalaya-stub.mjs");

interface StubHandle {
  binDir: string;
  stateDir: string;
}

function prepareStub(root: string): StubHandle {
  const binDir = join(root, "bin");
  const stateDir = join(root, "state");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const executable = join(binDir, "himalaya");
  writeFileSync(executable, readFileSync(STUB_SOURCE, "utf8"));
  chmodSync(executable, 0o755);
  return { binDir, stateDir };
}

async function withStubEnvironment<T>(handle: StubHandle, variables: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = { ...process.env };
  process.env.PATH = `${handle.binDir}${delimiter}${previous.PATH ?? ""}`;
  process.env.MC_STUB_DIR = handle.stateDir;
  Object.assign(process.env, variables);
  try {
    return await run();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

function observedCounts(stateDir: string): number[] {
  return lines(join(stateDir, "observed.log")).map((line) => Number(line.split(" ")[1]));
}

function attemptsFor(stateDir: string, id: string): number {
  const file = join(stateDir, "attempts", id);
  return existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
}

function stubEnvelopes(count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index + 1),
    "message-id": `m${index + 1}@example.test`,
    subject: `Subject ${index + 1}`,
    from: "sender@example.test",
    to: ["recipient@example.test"],
    date: "2026-08-26T00:00:00Z",
    body: `body ${index + 1}`,
  }));
}

// The stub is a POSIX executable resolved through PATH, exactly like the real
// himalaya binary; Windows cannot spawn it without a shell, so only the
// seam-level tests below run there (see the in-process cases).
const posixOnly = process.platform === "win32" ? it.skip : it;

describe("issue #33 bounded Himalaya reads", () => {
  it("runs at most `limit` workers at once and preserves input order", async () => {
    const items = Array.from({ length: 25 }, (_, index) => index);
    let active = 0;
    let peak = 0;
    const doubled = await mapWithConcurrency(items, 4, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      active -= 1;
      return item * 2;
    });

    expect(peak).toBe(4);
    expect(doubled).toEqual(items.map((item) => item * 2));
  });

  it("reads envelopes through the configured executor without exceeding the pool", async () => {
    let active = 0;
    let peak = 0;
    const source = new HimalayaSource("stub", "INBOX", undefined, 1000, undefined, {
      concurrency: 4,
      exec: async (args) => {
        if (args.includes("envelope")) return { stdout: JSON.stringify({ envelopes: stubEnvelopes(12) }) };
        const id = args[args.indexOf("read") + 1];
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 3));
        active -= 1;
        return { stdout: JSON.stringify({ message: `raw mime ${id}` }) };
      },
    });

    const messages = await source.list();

    expect(messages.map((message) => message.providerKey)).toEqual(Array.from({ length: 12 }, (_, index) => String(index + 1)));
    expect(messages[0].rawMime).toBe("raw mime 1");
    expect(peak).toBe(4);
  });

  posixOnly("reads a page with a bounded pool instead of one process per envelope", async () => {
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-issue-33-pool-"));
    const handle = prepareStub(root);
    try {
      const messages = await withStubEnvironment(handle, { MC_STUB_COUNT: "12", MC_STUB_LIMIT: "4" }, () =>
        new HimalayaSource("stub", "INBOX").list());

      expect(messages.map((message) => message.providerKey)).toEqual(Array.from({ length: 12 }, (_, index) => String(index + 1)));
      expect(Math.max(...observedCounts(handle.stateDir))).toBeLessThanOrEqual(4);
      expect(lines(join(handle.stateDir, "throttled.log"))).toEqual([]);
    } finally {
      // Stub processes that were already spawned keep writing slot files until
      // they exit, so the removal needs Node's built-in retry.
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 60_000);
});
