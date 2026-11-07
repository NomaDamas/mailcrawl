import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "../src/archive.js";
import { EmbedderRequestError } from "../src/embedding.js";
import type { EmbedderConfig, MailMessage } from "../src/types.js";

// A recording embedder that rejects every request carrying a marked text with
// an HTTP rejection — one over-context chunk failing a whole provider request.
const recorder = vi.hoisted(() => ({
  rejectMarked: true,
  crash: false,
}));

vi.mock("../src/embedding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/embedding.js")>();
  return {
    ...actual,
    createEmbedder: async () => ({
      embedDocuments: async (texts: string[]) => {
        if (recorder.crash) throw new Error("injected embedder crash");
        if (recorder.rejectMarked && texts.some((text) => text.includes("OVERCONTEXT"))) {
          throw new EmbedderRequestError(413, "embedding provider returned HTTP 413");
        }
        return texts.map((text) => axisAt(text.charCodeAt(text.length - 1) % 128));
      },
      embedQuery: async (query: string) => axisAt(query.charCodeAt(query.length - 1) % 128),
    }),
  };
});

function axisAt(index: number, dimension = 128): number[] {
  const vector = new Array<number>(dimension).fill(0);
  vector[index] = 1;
  return vector;
}

function message(index: number, text: string): MailMessage {
  return {
    accountId: "gmail", mailbox: "INBOX", providerKey: `p${index}`, messageId: `m${index}`,
    threadId: `t${index}`, subject: `Subject ${index}`, from: `from${index}@example.com`,
    to: ["to@example.com"], cc: [], date: "2026-08-26T10:00:00Z", text,
  };
}

const config: EmbedderConfig = { provider: "mock", batchSize: 4 };
const queueState = (archive: Archive, chunkId: string) =>
  archive.db.prepare("SELECT state, attempts FROM embedding_queue WHERE chunk_id = ?").get(chunkId) as { state: string; attempts: number };

describe("provider rejections are isolated instead of aborting the index run", () => {
  it("indexes the accepted chunks, marks the rejected ones failed, and reports them", async () => {
    recorder.rejectMarked = true;
    recorder.crash = false;
    const dataDir = mkdtempSync(join(tmpdir(), "mailcrawl-embed-rejections-"));
    const archive = new Archive(join(dataDir, "archive.sqlite"), config);
    try {
      await archive.sync(Array.from({ length: 5 }, (_, index) =>
        message(index, index === 2 ? "body OVERCONTEXT boom" : `body ${index}`)));

      const report = await archive.indexSemantic();
      expect(report.failed).toBe(1);
      expect(report.embedded).toBe(4);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]).toContain("embedding provider returned HTTP 413");

      const rejected = queueState(archive, archive.db.prepare(
        "SELECT chunk_id FROM chunks WHERE text LIKE '%OVERCONTEXT%'").get()!.chunk_id as string);
      expect(rejected).toMatchObject({ state: "failed", attempts: 1 });
      expect(archive.db.prepare("SELECT COUNT(*) AS count FROM embedding_queue WHERE state = 'complete'").get()).toMatchObject({ count: 4 });
      expect(archive.status().embeddingFailed).toBe(1);

      const hits = await archive.searchSemantic("body 3");
      expect(hits[0]?.snippet).toContain("body 3");
    } finally {
      archive.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("retries failed rows on the next run and completes them once accepted", async () => {
    recorder.rejectMarked = true;
    recorder.crash = false;
    const dataDir = mkdtempSync(join(tmpdir(), "mailcrawl-embed-rejections-retry-"));
    const archive = new Archive(join(dataDir, "archive.sqlite"), config);
    try {
      await archive.sync([message(0, "body ok"), message(1, "body OVERCONTEXT boom")]);
      const first = await archive.indexSemantic();
      expect(first).toMatchObject({ embedded: 1, failed: 1 });

      const chunkId = archive.db.prepare("SELECT chunk_id FROM chunks WHERE text LIKE '%OVERCONTEXT%'").get()!.chunk_id as string;
      const second = await archive.indexSemantic();
      expect(second).toMatchObject({ embedded: 0, failed: 1 });
      expect(queueState(archive, chunkId)).toMatchObject({ state: "failed", attempts: 2 });

      recorder.rejectMarked = false;
      const third = await archive.indexSemantic();
      expect(third).toMatchObject({ embedded: 1, failed: 0 });
      expect(queueState(archive, chunkId)).toMatchObject({ state: "complete" });
      expect(archive.status()).toMatchObject({ embeddingBacklog: 0, embeddingFailed: 0 });
    } finally {
      archive.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("still aborts and resumes on crashes that are not provider rejections", async () => {
    recorder.rejectMarked = false;
    recorder.crash = true;
    const dataDir = mkdtempSync(join(tmpdir(), "mailcrawl-embed-rejections-crash-"));
    const archive = new Archive(join(dataDir, "archive.sqlite"), config);
    try {
      await archive.sync(Array.from({ length: 6 }, (_, index) => message(index, `body ${index}`)));
      await expect(archive.indexSemantic()).rejects.toThrow("injected embedder crash");
      expect(archive.db.prepare("SELECT COUNT(*) AS count FROM embedding_queue WHERE state = 'failed'").get()).toMatchObject({ count: 0 });

      recorder.crash = false;
      const resumed = await archive.indexSemantic();
      expect(resumed).toMatchObject({ embedded: 6, failed: 0 });
    } finally {
      archive.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
