import { describe, expect, it, vi } from "vitest";
import { Archive } from "../src/archive.js";

vi.mock("../src/embedding.js", () => ({
  createEmbedder: async () => ({
    embedDocuments: async (texts: string[]) => texts.map(() => [1, 0, 0]),
    embedQuery: async () => [1, 0, 0],
  }),
  embeddingModelName: () => "test-model",
}));

describe("issue 8: embedding queue lifecycle", () => {
  it("marks indexed embedding queue rows complete", async () => {
    const archive = new Archive();
    await archive.sync([{
      accountId: "gmail", mailbox: "INBOX", providerKey: "provider-1", messageId: "message-1",
      threadId: "thread-1", subject: "Queue", from: "alice@example.com", to: [], cc: [],
      date: "2026-08-26T10:00:00Z", text: "Queue content.",
    }]);

    await archive.indexSemantic();

    expect(archive.db.prepare("SELECT state FROM embedding_queue").all()).toEqual([{ state: "complete" }]);
    archive.close();
  });
});
