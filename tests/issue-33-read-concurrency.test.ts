import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
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

function stubEnv(handle: StubHandle, variables: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MAILCRAWL_EMBEDDER: "mock",
    PATH: `${handle.binDir}${delimiter}${process.env.PATH ?? ""}`,
    MC_STUB_DIR: handle.stateDir,
    ...variables,
  };
}

function runCli(dataDir: string, args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["dist/cli/index.js", "--data-dir", dataDir, ...args], { encoding: "utf8", env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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

  it("stops dispatching page reads after a worker failure", async () => {
    const items = Array.from({ length: 40 }, (_, index) => index);
    const started: number[] = [];
    const run = mapWithConcurrency(items, 4, async (item) => {
      started.push(item);
      if (item === 0) throw new Error("boom");
      return item;
    });

    await expect(run).rejects.toThrow("boom");
    expect(started).toEqual([0, 1, 2, 3]);

    // The in-flight workers must exit instead of consuming the rest of the
    // page; a macrotask drains any leaked microtask cascade first.
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1, 2, 3]);
  });

  it("retries a transient read failure with growing backoff until it succeeds", async () => {
    const attempts = new Map<string, number>();
    const attemptTimes: number[] = [];
    const transient = (id: string) => Object.assign(new Error(`Command failed: himalaya -a stub --json message read ${id} --raw`), {
      stderr: "FETCH returned no body for the requested message",
    });
    const source = new HimalayaSource("stub", "INBOX", undefined, 1000, undefined, {
      concurrency: 4,
      retryAttempts: 3,
      retryBaseDelayMs: 60,
      exec: async (args) => {
        if (args.includes("envelope")) return { stdout: JSON.stringify({ envelopes: stubEnvelopes(12) }) };
        const id = args[args.indexOf("read") + 1];
        const attempt = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, attempt);
        if (id === "7") {
          attemptTimes.push(Date.now());
          if (attempt < 3) throw transient(id);
        }
        return { stdout: JSON.stringify({ message: `raw mime ${id}` }) };
      },
    });

    const messages = await source.list();

    expect(messages).toHaveLength(12);
    expect(attempts.get("7")).toBe(3);
    expect(attemptTimes).toHaveLength(3);
    // 60ms before the second attempt and 120ms before the third; lower bounds
    // only, so a slow machine can stretch the gaps but never shrink them.
    expect(attemptTimes[1] - attemptTimes[0]).toBeGreaterThanOrEqual(50);
    expect(attemptTimes[2] - attemptTimes[1]).toBeGreaterThanOrEqual(100);
  });

  posixOnly("retries a transiently failing read until it succeeds", async () => {
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-issue-33-retry-"));
    const handle = prepareStub(root);
    try {
      const messages = await withStubEnvironment(
        handle,
        { MC_STUB_COUNT: "12", MC_STUB_LIMIT: "4", MC_STUB_READ_DELAY_MS: "40", MC_STUB_FAIL_ONCE: "7:2" },
        () => new HimalayaSource("stub", "INBOX").list());

      expect(messages.map((message) => message.providerKey)).toEqual(Array.from({ length: 12 }, (_, index) => String(index + 1)));
      expect(attemptsFor(handle.stateDir, "7")).toBe(3);
      expect(lines(join(handle.stateDir, "throttled.log"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 60_000);

  it("syncs the messages it could read and reports the failures with himalaya stderr", async () => {
    const attempts = new Map<string, number>();
    const source = new HimalayaSource("stub", "INBOX", undefined, 1000, undefined, {
      concurrency: 4,
      retryAttempts: 3,
      retryBaseDelayMs: 5,
      exec: async (args) => {
        if (args.includes("envelope")) return { stdout: JSON.stringify({ envelopes: stubEnvelopes(12) }) };
        const id = args[args.indexOf("read") + 1];
        attempts.set(id, (attempts.get(id) ?? 0) + 1);
        if (id === "9") {
          throw Object.assign(new Error(`Command failed: himalaya -a stub --json message read ${id} --raw`), {
            stderr: "FETCH returned no body for the requested message",
          });
        }
        return { stdout: JSON.stringify({ message: `raw mime ${id}` }) };
      },
    });

    const result = await source.collect();

    expect(result.messages.map((message) => message.providerKey)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "10", "11", "12"]);
    expect(attempts.get("9")).toBe(3);
    expect(result.failures).toEqual([
      { providerKey: "9", attempts: 3, error: expect.stringContaining("FETCH returned no body for the requested message") },
    ]);
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

describe("issue #33 sync CLI contract", () => {
  it("rejects an invalid --concurrency before reading the mailbox", () => {
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-issue-33-cli-invalid-"));
    try {
      const result = runCli(join(root, "data"), ["sync", "--source", "himalaya", "--account", "stub", "--concurrency", "0", "--json"], { ...process.env });

      expect(result.status).not.toBe(0);
      expect(JSON.parse(result.stderr).error).toContain("--concurrency must be a positive integer");
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  posixOnly("syncs readable messages, reports failures, and exits zero", () => {
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-issue-33-cli-partial-"));
    const handle = prepareStub(root);
    const dataDir = join(root, "data");
    try {
      const variables = { MC_STUB_COUNT: "12", MC_STUB_FAIL_ALWAYS: "9", MC_STUB_READ_DELAY_MS: "40" };
      const sync = runCli(dataDir, ["sync", "--source", "himalaya", "--account", "stub", "--mailbox", "INBOX", "--page-size", "12", "--json"], stubEnv(handle, variables));

      expect(sync.status).toBe(0);
      expect(JSON.parse(sync.stdout)).toMatchObject({
        added: 11,
        failures: [{ providerKey: "9", attempts: 3, error: expect.stringContaining("FETCH returned no body for the requested message") }],
      });
      expect(JSON.parse(runCli(dataDir, ["status", "--json"], { ...process.env }).stdout)).toMatchObject({ archivePresent: true, messageCount: 11 });

      // A second bounded run only re-reads the same page and stays incremental.
      const rerun = runCli(dataDir, ["sync", "--source", "himalaya", "--account", "stub", "--page-size", "12", "--concurrency", "2", "--json"], stubEnv(handle, variables));
      expect(rerun.status).toBe(0);
      expect(JSON.parse(rerun.stdout)).toMatchObject({ added: 0, unchanged: 11 });
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 60_000);

  posixOnly("exits nonzero only when nothing could be read", () => {
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-issue-33-cli-failed-"));
    const handle = prepareStub(root);
    const dataDir = join(root, "data");
    try {
      const sync = runCli(dataDir, ["sync", "--source", "himalaya", "--account", "stub", "--page-size", "6", "--concurrency", "2", "--json"], stubEnv(handle, {
        MC_STUB_COUNT: "6",
        MC_STUB_FAIL_ALWAYS: "1,2,3,4,5,6",
        MC_STUB_READ_DELAY_MS: "30",
      }));

      expect(sync.status).not.toBe(0);
      expect(JSON.parse(sync.stderr).error).toContain("no messages could be read");
      expect(JSON.parse(runCli(dataDir, ["status", "--json"], { ...process.env }).stdout)).toMatchObject({ messageCount: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 60_000);

  posixOnly("keeps an empty page a successful sync", () => {
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-issue-33-cli-empty-"));
    const handle = prepareStub(root);
    const dataDir = join(root, "data");
    try {
      const sync = runCli(dataDir, ["sync", "--source", "himalaya", "--account", "stub", "--page-size", "12", "--concurrency", "4", "--json"], stubEnv(handle, { MC_STUB_COUNT: "0" }));

      expect(sync.status).toBe(0);
      expect(JSON.parse(sync.stdout)).toMatchObject({ added: 0, failures: [] });
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 60_000);
});
