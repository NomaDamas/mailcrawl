import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "../src/archive.js";

vi.mock("../src/embedding.js", () => ({
  createEmbedder: async () => ({
    embedDocuments: async (texts: string[]) => {
      if (!texts.length) throw new Error("text array must be non-empty");
      return texts.map(() => [1, 0, 0]);
    },
    embedQuery: async () => [1, 0, 0],
  }),
  embeddingModelName: () => "test-model",
}));

describe("issue 5: repeated sync and semantic index", () => {
  it("does not embed an empty batch after an unchanged sync", async () => {
    const archive = new Archive();
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-issue-5-"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));
    const message = {
      accountId: "fixture", mailbox: "INBOX", providerKey: "refund-policy-1",
      messageId: "<refund-policy-1@example.com>", threadId: "refund-thread-1",
      subject: "Refund policy", from: "finance@example.com",
      to: ["support@example.com"], cc: [],
      date: "2026-08-31T10:00:00Z",
      text: "Refund exceptions require director approval before payout.",
    };

    try {
      await archive.sync([message]);
      const first = await archive.indexSemanticGeneration(root);
      await archive.sync([message]);
      vi.advanceTimersByTime(1);
      const second = await archive.indexSemanticGeneration(root);

      expect(first.embedded).toBe(1);
      expect(second).toMatchObject({ embedded: 0, reused: 1 });
    } finally {
      archive.close();
      rmSync(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });
});
