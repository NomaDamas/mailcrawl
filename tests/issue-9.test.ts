import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "../src/archive.js";

vi.mock("../src/embedding.js", () => ({
  createEmbedder: async () => ({
    embedDocuments: async (texts: string[]) => texts.map(() => [1, 0, 0]),
    embedQuery: async () => [1, 0, 0],
  }),
  embeddingModelName: () => "test-model",
}));

const message = (text: string) => ({
  accountId: "gmail",
  mailbox: "INBOX",
  providerKey: "provider-1",
  messageId: "message-1",
  threadId: "thread-1",
  subject: "Contract renewal",
  from: "alice@example.com",
  to: [],
  cc: [],
  date: "2026-08-26T10:00:00Z",
  text,
});

describe("issue 9: semantic orphan cleanup", () => {
  it("removes replaced chunk vectors and queue rows when message content shrinks", async () => {
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-issue-9-"));
    const archive = new Archive();
    // Two-paragraph text produces multiple chunks
    await archive.sync([message(`${"First paragraph.".repeat(100)}\n\n${"Second paragraph.".repeat(100)}`)]);
    await archive.indexSemanticGeneration(root);

    // Shrink to one paragraph — fewer chunks produced
    await archive.sync([message("Short replacement.")]);
    const second = await archive.indexSemanticGeneration(root);
    const manifest = JSON.parse(readFileSync(join(root, "generations", second.generation, "manifest.json"), "utf8")) as {
      vectors: unknown[];
    };
    const counts = {
      chunks: (archive.db.prepare("SELECT COUNT(*) AS count FROM chunks").get() as { count: number }).count,
      vectors: (archive.db.prepare("SELECT COUNT(*) AS count FROM semantic_vectors").get() as { count: number }).count,
      queued: (archive.db.prepare("SELECT COUNT(*) AS count FROM embedding_queue").get() as { count: number }).count,
    };

    expect(counts).toEqual({ chunks: 1, vectors: 1, queued: 1 });
    expect(manifest.vectors).toHaveLength(1);
    archive.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("publishes generation manifest with only current chunk vectors", async () => {
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-issue-9-manifest-"));
    const archive = new Archive();
    // Long text produces 2+ chunks
    await archive.sync([message(`${"Long paragraph.".repeat(120)}`)]);
    await archive.indexSemanticGeneration(root);

    // Change to different-length content that produces a different number of chunks
    await archive.sync([message("Terse.")]);
    const second = await archive.indexSemanticGeneration(root);
    const manifest = JSON.parse(readFileSync(join(root, "generations", second.generation, "manifest.json"), "utf8")) as {
      vectors: Array<{ chunk_id: string }>;
    };

    const chunkCount = (archive.db.prepare("SELECT COUNT(*) AS count FROM chunks").get() as { count: number }).count;
    const orphanCount = (archive.db.prepare(
      "SELECT COUNT(*) AS count FROM semantic_vectors WHERE chunk_id NOT IN (SELECT chunk_id FROM chunks)",
    ).get() as { count: number }).count;

    // Manifest vector count matches current chunk count
    expect(manifest.vectors).toHaveLength(chunkCount);
    // Zero orphan vectors
    expect(orphanCount).toBe(0);
    archive.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("cleans persisted orphan rows from a previous interrupted sync", async () => {
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-issue-9-upgrade-"));
    const archivePath = join(root, "archive.sqlite");
    const archive = new Archive(archivePath);
    await archive.sync([message("Current content.")]);
    await archive.indexSemantic();
    // Inject orphan rows that simulate an interrupted sync crash
    archive.db.prepare("INSERT INTO semantic_vectors (chunk_id, content_hash, model, vector) VALUES (?, ?, ?, ?)")
      .run("stale-chunk", "stale-hash", "test-model", "[1,0,0]");
    archive.db.prepare("INSERT INTO embedding_queue (chunk_id, content_hash, state, attempts) VALUES (?, ?, ?, ?)")
      .run("stale-chunk", "stale-hash", "pending", 0);
    archive.close();

    // Reopening should clean orphans
    const reopened = new Archive(archivePath);
    const generation = await reopened.indexSemanticGeneration(root);
    const manifest = JSON.parse(readFileSync(join(root, "generations", generation.generation, "manifest.json"), "utf8")) as {
      vectors: Array<{ chunk_id: string }>;
    };

    expect(manifest.vectors).toHaveLength(1);
    expect(manifest.vectors[0]?.chunk_id).not.toBe("stale-chunk");
    expect(reopened.db.prepare("SELECT COUNT(*) AS count FROM semantic_vectors").get()).toEqual({ count: 1 });
    expect(reopened.db.prepare("SELECT COUNT(*) AS count FROM embedding_queue").get()).toEqual({ count: 1 });
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  });
});