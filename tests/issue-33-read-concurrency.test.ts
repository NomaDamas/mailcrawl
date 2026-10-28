import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { HimalayaSource, mapWithConcurrency } from "../src/source.js";
import { Archive } from "../src/archive.js";

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

  it("fetches only new or changed envelopes using persisted source hashes", async () => {
    const archive = new Archive();
    const readIds: string[] = [];
    let envelopes = stubEnvelopes(3) as Array<Record<string, unknown>>;
    const collect = () => new HimalayaSource("stub", "INBOX", undefined, 1000, undefined, {
      exec: async (args) => {
        if (args.includes("envelope")) return { stdout: JSON.stringify({ envelopes }) };
        const id = args[args.indexOf("read") + 1];
        readIds.push(id);
        return { stdout: JSON.stringify({ message: `raw mime ${id}` }) };
      },
    }).collect({
      previous: (providerKey) => archive.messageSourceHash("stub", "INBOX", providerKey),
    });

    try {
      const first = await collect();
      await archive.sync(first.messages);
      expect(readIds).toEqual(["1", "2", "3"]);

      const second = await collect();
      expect(second.messages).toEqual([]);
      expect(second.unchanged).toBe(3);
      expect(readIds).toEqual(["1", "2", "3"]);

      envelopes = envelopes.map((envelope) => envelope.id === "2" ? { ...envelope, subject: "Changed subject" } : envelope);
      const third = await collect();
      expect(third.messages.map((message) => message.providerKey)).toEqual(["2"]);
      expect(third.unchanged).toBe(2);
      expect(readIds).toEqual(["1", "2", "3", "2"]);
    } finally {
      archive.close();
    }
  });

  it("skips unchanged excluded mail and rereads when the exclusion policy changes", async () => {
    const archive = new Archive();
    const envelopes = stubEnvelopes(1) as Array<Record<string, unknown>>;
    envelopes[0].labels = ["CATEGORY_PROMOTIONS"];
    let reads = 0;
    const collect = (excludedCategories?: string[]) => new HimalayaSource("stub", "INBOX", undefined, 1000, undefined, {
      exec: async (args) => {
        if (args.includes("envelope")) return { stdout: JSON.stringify({ envelopes }) };
        reads += 1;
        return { stdout: JSON.stringify({ message: "raw mime 1" }) };
      },
    }).collect({
      previous: (providerKey) => archive.messageSourceHash("stub", "INBOX", providerKey, excludedCategories),
    });

    try {
      const first = await collect();
      await archive.sync(first.messages);
      expect(archive.status().messageCount).toBe(0);

      const second = await collect();
      expect(second.unchanged).toBe(1);
      expect(reads).toBe(1);

      const changedPolicy = await collect([]);
      expect(changedPolicy.messages).toHaveLength(1);
      expect(reads).toBe(2);
    } finally {
      archive.close();
    }
  });

  it("checkpoints readable messages before the whole page finishes", async () => {
    const archive = new Archive();
    const checkpointed: string[] = [];
    const source = new HimalayaSource("stub", "INBOX", undefined, 1000, undefined, {
      concurrency: 1,
      exec: async (args) => {
        if (args.includes("envelope")) return { stdout: JSON.stringify({ envelopes: stubEnvelopes(3) }) };
        const id = args[args.indexOf("read") + 1];
        return { stdout: JSON.stringify({ message: `raw mime ${id}` }) };
      },
    });

    try {
      const result = await source.collect({
        checkpoint: async (message) => {
          checkpointed.push(message.providerKey);
          await archive.sync([message]);
        },
      });

      expect(checkpointed).toEqual(["1", "2", "3"]);
      expect(archive.status().messageCount).toBe(3);
      expect(result.messages).toHaveLength(3);
    } finally {
      archive.close();
    }
  });

  it("resumes after an interrupted checkpoint without reading committed mail again", async () => {
    const archive = new Archive();
    const readIds: string[] = [];
    let interrupted = true;
    const collect = () => new HimalayaSource("stub", "INBOX", undefined, 1000, undefined, {
      concurrency: 1,
      exec: async (args) => {
        if (args.includes("envelope")) return { stdout: JSON.stringify({ envelopes: stubEnvelopes(3) }) };
        const id = args[args.indexOf("read") + 1];
        readIds.push(id);
        return { stdout: JSON.stringify({ message: `raw mime ${id}` }) };
      },
    }).collect({
      previous: (providerKey) => archive.messageSourceHash("stub", "INBOX", providerKey),
      checkpoint: async (message) => {
        await archive.sync([message]);
        if (interrupted && message.providerKey === "1") throw new Error("interrupted");
      },
    });

    try {
      await expect(collect()).rejects.toThrow("interrupted");
      expect(archive.status().messageCount).toBe(1);

      interrupted = false;
      const resumed = await collect();

      expect(resumed.unchanged).toBe(1);
      expect(resumed.messages.map((message) => message.providerKey)).toEqual(["2", "3"]);
      expect(readIds).toEqual(["1", "2", "3"]);
      expect(archive.status().messageCount).toBe(3);
    } finally {
      archive.close();
    }
  });

  it("times out each read attempt instead of waiting forever", async () => {
    const source = new HimalayaSource("stub", "INBOX", undefined, 1000, undefined, {
      retryAttempts: 1,
      readTimeoutMs: 10,
      exec: async (args) => {
        if (args.includes("envelope")) return { stdout: JSON.stringify({ envelopes: stubEnvelopes(1) }) };
        return new Promise(() => {});
      },
    });

    const result = await source.collect();

    expect(result.messages).toEqual([]);
    expect(result.failures).toEqual([
      { providerKey: "1", attempts: 1, error: expect.stringContaining("himalaya message read timed out after 10ms") },
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

  it("rejects an invalid --read-timeout before reading the mailbox", () => {
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-read-timeout-invalid-"));
    try {
      const result = runCli(join(root, "data"), ["sync", "--source", "himalaya", "--account", "stub", "--read-timeout", "0", "--json"], { ...process.env });

      expect(result.status).not.toBe(0);
      expect(JSON.parse(result.stderr).error).toContain("--read-timeout must be a positive integer");
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

      // A second run retries only the failed message; unchanged mail is not downloaded.
      const rerun = runCli(dataDir, ["sync", "--source", "himalaya", "--account", "stub", "--page-size", "12", "--concurrency", "2", "--json"], stubEnv(handle, variables));
      expect(rerun.status).toBe(0);
      expect(JSON.parse(rerun.stdout)).toMatchObject({ added: 0, unchanged: 11 });
      expect(attemptsFor(handle.stateDir, "1")).toBe(1);
      expect(attemptsFor(handle.stateDir, "9")).toBe(6);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, 60_000);

  posixOnly("kills a real himalaya process when a read exceeds its timeout", () => {
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-read-timeout-"));
    const handle = prepareStub(root);
    const dataDir = join(root, "data");
    try {
      const started = Date.now();
      const sync = runCli(dataDir, ["sync", "--source", "himalaya", "--account", "stub", "--page-size", "1", "--read-timeout", "150", "--json"], stubEnv(handle, {
        MC_STUB_COUNT: "1",
        MC_STUB_READ_DELAY_MS: "5000",
      }));

      expect(Date.now() - started).toBeLessThan(2_000);
      expect(sync.status).not.toBe(0);
      expect(JSON.parse(sync.stderr).error).toContain("no messages could be read");
      expect(lines(join(handle.stateDir, "started.log"))).toEqual(["1", "1", "1"]);
      expect(attemptsFor(handle.stateDir, "1")).toBe(0);
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
