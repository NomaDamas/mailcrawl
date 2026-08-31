import { describe, expect, it, vi } from "vitest";
import { Archive } from "../src/archive.js";

const { createEmbedder } = vi.hoisted(() => ({
  createEmbedder: vi.fn(),
}));

vi.mock("../src/embedding.js", () => ({
  createEmbedder,
  embeddingModelName: () => "test-model",
}));

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

    expect(archive.db.prepare("SELECT chunk_id FROM semantic_vectors").all()).toEqual([]);
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
    const vectors = archive.db.prepare("SELECT chunk_id FROM semantic_vectors").all() as { chunk_id: string }[];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.chunk_id).not.toBe(oldChunkId);
    expect(vectors).toEqual([]);
    archive.close();
  });
});
