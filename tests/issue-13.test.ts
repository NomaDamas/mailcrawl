import { describe, expect, it, vi } from "vitest";
import { Archive } from "../src/archive.js";
import { normalizeMessage } from "../src/normalize.js";

vi.mock("../src/embedding.js", () => ({
  createEmbedder: async () => ({
    embedDocuments: async (texts: string[]) => texts.map((text) => text.includes("old attachment") ? [1, 0] : [0, 1]),
    embedQuery: async (query: string) => query.includes("old attachment") ? [1, 0] : [0, 1],
  }),
  embeddingModelName: () => "test-model",
}));

const message = (attachmentText: string) => ({
  accountId: "gmail",
  mailbox: "INBOX",
  providerKey: "provider-1",
  messageId: "message-1",
  threadId: "thread-1",
  subject: "Attachment update",
  from: "alice@example.com",
  to: [],
  cc: [],
  date: "2026-08-26T10:00:00Z",
  text: "",
  attachments: [{ name: "notes.txt", mimeType: "text/plain", text: attachmentText }],
});

describe("issue 13: attachment-only updates", () => {
  it("invalidates the normalized hash when attachment text changes", async () => {
    const first = await normalizeMessage(message("old attachment text"));
    const second = await normalizeMessage(message("new attachment text"));

    expect(second.normalizedHash).not.toBe(first.normalizedHash);
  });

  it("invalidates the normalized hash when attachment identity changes", async () => {
    const first = await normalizeMessage(message("same attachment text"));
    const second = await normalizeMessage({
      ...message("same attachment text"),
      attachments: [{ name: "renamed.txt", mimeType: "text/plain", text: "same attachment text" }],
    });

    expect(second.normalizedHash).not.toBe(first.normalizedHash);
  });

  it("rebuilds lexical and semantic state without stale attachment data", async () => {
    const archive = new Archive();
    await archive.sync([message("old attachment text")]);
    const oldChunk = archive.db.prepare("SELECT chunk_id FROM chunks").get() as { chunk_id: string };
    await archive.indexSemantic();

    expect(await archive.searchBm25("old attachment")).toHaveLength(1);
    expect(await archive.searchSemantic("old attachment")).toHaveLength(1);

    const report = await archive.sync([message("new attachment text")]);
    const newChunk = archive.db.prepare("SELECT chunk_id, content_hash FROM chunks").get() as { chunk_id: string; content_hash: string };

    expect(report).toMatchObject({ added: 0, updated: 1, unchanged: 0 });
    expect(newChunk.chunk_id).not.toBe(oldChunk.chunk_id);
    expect(await archive.searchBm25("old attachment")).toHaveLength(0);
    expect(await archive.searchBm25("new attachment")).toHaveLength(1);
    expect(await archive.searchSemantic("old attachment")).toHaveLength(0);
    expect(archive.db.prepare("SELECT chunk_id FROM semantic_vectors WHERE chunk_id = ?").get(oldChunk.chunk_id)).toBeUndefined();
    expect(archive.db.prepare("SELECT chunk_id FROM embedding_queue WHERE chunk_id = ?").get(oldChunk.chunk_id)).toBeUndefined();
    expect(archive.db.prepare("SELECT state, content_hash FROM embedding_queue WHERE chunk_id = ?").get(newChunk.chunk_id)).toEqual({ state: "pending", content_hash: newChunk.content_hash });

    expect(await archive.indexSemantic()).toMatchObject({ embedded: 1, reused: 0 });
    expect(archive.db.prepare("SELECT chunk_id, content_hash FROM semantic_vectors").all()).toEqual([newChunk]);
    archive.close();
  });
});
