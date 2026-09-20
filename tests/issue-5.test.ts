import { describe, expect, it, vi } from "vitest";
import { Archive } from "../src/archive.js";

vi.mock("../src/embedding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/embedding.js")>();
  return {
    ...actual,
    createEmbedder: async () => ({
      embedDocuments: async (texts: string[]) => {
        if (!texts.length) throw new Error("text array must be non-empty");
        return texts.map(() => [1, 0, 0]);
      },
      embedQuery: async () => [1, 0, 0],
    }),
  };
});

describe("issue 5: repeated sync and semantic index", () => {
  it("does not embed an empty batch after an unchanged sync", async () => {
    const archive = new Archive();
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
      const first = await archive.indexSemantic();
      await archive.sync([message]);
      const second = await archive.indexSemantic();

      expect(first.embedded).toBe(1);
      expect(second).toMatchObject({ embedded: 0, reused: 1 });
    } finally {
      archive.close();
    }
  });
});
