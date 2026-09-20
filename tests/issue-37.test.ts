import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Archive } from "../src/archive.js";
import type { MailMessage } from "../src/types.js";

const run = promisify(execFile);

const recorder = vi.hoisted(() => ({
  callSizes: [] as number[],
  failAfterCall: Number.POSITIVE_INFINITY,
}));

vi.mock("../src/embedding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/embedding.js")>();
  return {
    ...actual,
    createEmbedder: async () => ({
      embedDocuments: async (texts: string[]) => {
        recorder.callSizes.push(texts.length);
        if (recorder.callSizes.length > recorder.failAfterCall) throw new Error("injected embedder crash");
        return texts.map((_, index) => [index + 1, 0, 0]);
      },
      embedQuery: async () => [1, 0, 0],
    }),
  };
});

function messages(count: number): MailMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    accountId: "a", mailbox: "INBOX", providerKey: `p${index}`, messageId: `m${index}`,
    threadId: `t${index}`, subject: `Batch ${index}`, from: "a@example.com", to: [], cc: [],
    date: "2026-08-26T00:00:00Z", text: `batch body ${index}`,
  }));
}

describe("issue #37 batched semantic indexing", () => {
  it("embeds in bounded batches and commits each batch so a crash resumes", async () => {
    recorder.callSizes = [];
    recorder.failAfterCall = 2;
    const archive = new Archive();
    try {
      await archive.sync(messages(70));

      await expect(archive.indexSemantic()).rejects.toThrow("injected embedder crash");

      expect(recorder.callSizes.length).toBeGreaterThan(1);
      expect(Math.max(...recorder.callSizes)).toBeLessThanOrEqual(32);
      const committed = archive.db.prepare("SELECT COUNT(*) AS count FROM embedding_queue WHERE state = 'complete'").get() as { count: number };
      expect(committed.count).toBe(recorder.callSizes.slice(0, 2).reduce((sum, size) => sum + size, 0));

      recorder.failAfterCall = Number.POSITIVE_INFINITY;
      const resumed = await archive.indexSemantic();
      const remaining = archive.db.prepare("SELECT COUNT(*) AS count FROM embedding_queue WHERE state = 'pending'").get() as { count: number };
      expect(remaining.count).toBe(0);
      expect(resumed.embedded).toBe(70 - committed.count);
    } finally {
      archive.close();
    }
  });

  it("doctor distinguishes an interrupted index from a healthy one", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mailcrawl-issue-37-doctor-"));
    const environment = { ...process.env, MAILCRAWL_EMBEDDER: "mock" };
    const cli = ["dist/cli/index.js", "--data-dir", dataDir];
    try {
      await run("node", [...cli, "sync", "--source", "fixture", "--fixture", "tests/fixtures/messages.json", "--json"], { env: environment });

      const before = JSON.parse((await run("node", [...cli, "doctor", "--json"], { env: environment })).stdout) as { semantic: { status: string } };
      expect(before.semantic.status).toBe("never-completed");

      await run("node", [...cli, "embed", "--json"], { env: environment });
      const after = JSON.parse((await run("node", [...cli, "doctor", "--json"], { env: environment })).stdout) as { semantic: { status: string } };
      expect(after.semantic.status).toBe("healthy");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
