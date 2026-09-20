import { describe, expect, it, vi } from "vitest";
import { Archive } from "../src/archive.js";

const { createEmbedder } = vi.hoisted(() => ({
  createEmbedder: vi.fn(),
}));

const plainEmbedder = () => ({
  embedDocuments: async (texts: string[]) => texts.map(() => [1, 0, 0]),
  embedQuery: async () => [1, 0, 0],
});

vi.mock("../src/embedding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/embedding.js")>();
  return { ...actual, createEmbedder };
});

type EmbedderGate = {
  readonly started: Promise<void>;
  readonly release: () => void;
};

function embedderGate(): EmbedderGate {
  let signalStarted: () => void = () => {};
  let releaseEmbedding: () => void = () => {};
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const released = new Promise<void>((resolve) => { releaseEmbedding = resolve; });
  createEmbedder.mockResolvedValueOnce({
    embedDocuments: async (texts: string[]) => {
      signalStarted();
      await released;
      return texts.map(() => [1, 0, 0]);
    },
    embedQuery: async () => [1, 0, 0],
  });
  return { started, release: releaseEmbedding };
}

const message = (text: string, classifications: string[] = []) => ({
  accountId: "gmail",
  mailbox: "INBOX",
  providerKey: "provider-1",
  messageId: "message-1",
  threadId: "thread-1",
  subject: "Concurrency",
  from: "alice@example.com",
  to: [],
  cc: [],
  date: "2026-08-26T10:00:00Z",
  text,
  classifications,
});

describe("issue 15: semantic indexing concurrency", () => {
  it("does not resurrect a vector when sync excludes its message", async () => {
    const archive = new Archive();
    await archive.sync([message("Content to remove.")]);
    const gate = embedderGate();

    const indexing = archive.indexSemantic();
    await gate.started;
    const syncing = archive.sync([message("Content to remove.", ["CATEGORY_SPAM"])]);
    gate.release();
    await Promise.all([indexing, syncing]);

    // The removed message leaves no searchable trace: queue rows are gone and
    // semantic search drops its orphaned vector row during hydration.
    expect(archive.db.prepare("SELECT chunk_id FROM embedding_queue").all()).toEqual([]);
    createEmbedder.mockResolvedValue(plainEmbedder());
    expect(await archive.searchSemantic("Content to remove.")).toHaveLength(0);
    archive.close();
  });

  it("does not retain a superseded chunk vector after sync replaces content", async () => {
    const archive = new Archive();
    await archive.sync([message("Original content.")]);
    const oldChunkId = (archive.db.prepare("SELECT chunk_id FROM chunks").get() as { chunk_id: string }).chunk_id;
    const gate = embedderGate();

    const indexing = archive.indexSemantic();
    await gate.started;
    const syncing = archive.sync([message("Superseding content.")]);
    gate.release();
    await Promise.all([indexing, syncing]);

    const chunks = archive.db.prepare("SELECT chunk_id FROM chunks").all() as { chunk_id: string }[];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.chunk_id).not.toBe(oldChunkId);
    // The superseded chunk is pending re-embedding and the old vector surfaces no hits.
    expect(archive.db.prepare("SELECT state FROM embedding_queue").all()).toEqual([{ state: "pending" }]);
    createEmbedder.mockResolvedValue(plainEmbedder());
    expect(await archive.searchSemantic("Original content.")).toHaveLength(0);
    // The next index run sweeps the superseded vector row and embeds the replacement.
    await archive.indexSemantic();
    expect(await archive.searchSemantic("Superseding content.")).toHaveLength(1);
    archive.close();
  });
});
