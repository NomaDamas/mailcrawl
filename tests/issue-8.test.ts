import { describe, expect, it, vi } from "vitest";
import { Archive } from "../src/archive.js";
import type { MailMessage } from "../src/types.js";

const { createEmbedder } = vi.hoisted(() => ({
  createEmbedder: vi.fn(async () => ({
    embedDocuments: async (texts: string[]) => texts.map(() => [1, 0, 0]),
    embedQuery: async () => [1, 0, 0],
  })),
}));

vi.mock("../src/embedding.js", () => ({
  createEmbedder,
  embeddingModelName: () => "test-model",
}));

const message: MailMessage = {
  accountId: "gmail",
  mailbox: "INBOX",
  providerKey: "provider-1",
  messageId: "message-1",
  threadId: "thread-1",
  subject: "Queue",
  from: "alice@example.com",
  to: [],
  cc: [],
  date: "2026-08-26T10:00:00Z",
  text: "Queue content.",
};

type QueueRow = { chunk_id: string; state: string };

describe("issue 8: embedding queue lifecycle", () => {
  it("marks indexed embedding queue rows complete", async () => {
    // Given a synced message with a pending embedding queue row
    const archive = new Archive();
    await archive.sync([message]);

    // When semantic indexing runs
    await archive.indexSemantic();

    // Then the queue row is complete
    expect(archive.db.prepare("SELECT state FROM embedding_queue").all()).toEqual([{ state: "complete" }]);
    archive.close();
  });

  it("reports zero embedding backlog on sync after a successful index", async () => {
    // Given a synced and fully indexed message
    const archive = new Archive();
    await archive.sync([message]);
    await archive.indexSemantic();

    // When the same message is synced again unchanged
    const report = await archive.sync([message]);

    // Then no embedding backlog remains
    expect(report.embeddingBacklog).toBe(0);
    archive.close();
  });

  it("drains re-enqueued rows through the reuse path without re-embedding", async () => {
    // Given an indexed message whose queue row is re-enqueued by a metadata-only change
    const archive = new Archive();
    await archive.sync([message]);
    await archive.indexSemantic();
    await archive.sync([{ ...message, labels: ["important"] }]);
    createEmbedder.mockClear();

    // When indexing runs while the stored vector is still current
    const index = await archive.indexSemantic();

    // Then the row is reused without initializing the embedder
    expect(index).toMatchObject({ embedded: 0, reused: 1 });
    expect(createEmbedder).not.toHaveBeenCalled();

    // And a later sync reports no backlog
    const report = await archive.sync([{ ...message, labels: ["important"] }]);
    expect(report.embeddingBacklog).toBe(0);
    archive.close();
  });

  it("removes stale queue rows for chunks replaced before any index run", async () => {
    // Given a message edited before its first index, orphaning the old queue row
    const archive = new Archive();
    await archive.sync([message]);
    await archive.sync([{ ...message, text: "Edited before any index run." }]);

    // When indexing runs
    await archive.indexSemantic();

    // Then the queue holds exactly the live chunks, all complete
    const queue = archive.db.prepare("SELECT chunk_id, state FROM embedding_queue").all() as QueueRow[];
    const chunks = archive.db.prepare("SELECT chunk_id FROM chunks").all() as { chunk_id: string }[];
    expect(queue.map((row) => row.chunk_id).sort()).toEqual(chunks.map((row) => row.chunk_id).sort());
    expect(queue.every((row) => row.state === "complete")).toBe(true);

    // And a later sync reports no backlog
    const report = await archive.sync([{ ...message, text: "Edited before any index run." }]);
    expect(report.embeddingBacklog).toBe(0);
    archive.close();
  });

  it("re-enqueues chunks whose queue rows are missing", async () => {
    // Given a synced chunk whose embedding queue row was lost
    const archive = new Archive();
    await archive.sync([message]);
    archive.db.prepare("DELETE FROM embedding_queue").run();

    // When indexing runs
    const index = await archive.indexSemantic();

    // Then the chunk is embedded and its queue row restored as complete
    expect(index.embedded).toBe(1);
    expect(archive.db.prepare("SELECT state FROM embedding_queue").all()).toEqual([{ state: "complete" }]);
    expect(archive.db.prepare("SELECT COUNT(*) AS count FROM semantic_vectors").get()).toMatchObject({ count: 1 });

    // And a later sync reports no backlog
    const report = await archive.sync([message]);
    expect(report.embeddingBacklog).toBe(0);
    archive.close();
  });
});
