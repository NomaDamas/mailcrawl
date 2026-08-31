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
  accountId: "gmail", mailbox: "INBOX", providerKey: "provider-1", messageId: "message-1",
  threadId: "thread-1", subject: "Contract", from: "alice@example.com", to: [], cc: [],
  date: "2026-08-26T10:00:00Z", text,
});

describe("issue 9: semantic orphan cleanup", () => {
  it("removes replaced chunk vectors and queue rows from published generations", async () => {
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-issue-9-"));
    const archive = new Archive();
    await archive.sync([message(`${"First paragraph.".repeat(100)}\n\n${"Second paragraph.".repeat(100)}`)]);
    await archive.indexSemanticGeneration(root);

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

  it("cleans persisted orphan rows before publishing a new generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-issue-9-upgrade-"));
    const archivePath = join(root, "archive.sqlite");
    const archive = new Archive(archivePath);
    await archive.sync([message("Current content.")]);
    await archive.indexSemantic();
    archive.db.prepare(`INSERT INTO semantic_vectors
      (chunk_id, content_hash, model, vector) VALUES (?, ?, ?, ?)`)
      .run("stale-chunk", "stale-hash", "test-model", "[1,0,0]");
    archive.db.prepare(`INSERT INTO embedding_queue
      (chunk_id, content_hash, state, attempts) VALUES (?, ?, ?, ?)`)
      .run("stale-chunk", "stale-hash", "pending", 0);
    archive.close();

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
