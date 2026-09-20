import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "../src/archive.js";

const axis128 = () => { const vector = new Array<number>(128).fill(0); vector[0] = 1; return vector; };

const { createEmbedder } = vi.hoisted(() => ({
  createEmbedder: vi.fn(async () => ({
    embedDocuments: async (texts: string[]) => texts.map(() => axis128()),
    embedQuery: async () => axis128(),
  })),
}));

vi.mock("../src/embedding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/embedding.js")>();
  return { ...actual, createEmbedder };
});

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

function counts(archive: Archive): { chunks: number; queued: number; complete: number } {
  const count = (sql: string) => (archive.db.prepare(sql).get() as { count: number }).count;
  return {
    chunks: count("SELECT COUNT(*) AS count FROM chunks"),
    queued: count("SELECT COUNT(*) AS count FROM embedding_queue"),
    complete: count("SELECT COUNT(*) AS count FROM embedding_queue WHERE state = 'complete'"),
  };
}

describe("issue 9: semantic orphan cleanup", () => {
  it("removes replaced chunk vectors and queue rows when message content shrinks", async () => {
    const archive = new Archive();
    // Two-paragraph text produces multiple chunks
    await archive.sync([message(`${"First paragraph.".repeat(100)}\n\n${"Second paragraph.".repeat(100)}`)]);
    await archive.indexSemantic();

    // Shrink to one paragraph — fewer chunks produced
    await archive.sync([message("Short replacement.")]);
    const second = await archive.indexSemantic();

    expect(counts(archive)).toEqual({ chunks: 1, queued: 1, complete: 1 });
    // The shrunken message re-embeds its single live chunk.
    expect(second.embedded).toBe(1);
    archive.close();
  });

  it("keeps the vector table aligned with current chunks", async () => {
    const archive = new Archive();
    // Long text produces 2+ chunks
    await archive.sync([message(`${"Long paragraph.".repeat(120)}`)]);
    await archive.indexSemantic();

    // Change to different-length content that produces a different number of chunks
    await archive.sync([message("Terse.")]);
    await archive.indexSemantic();

    const { chunks, queued, complete } = counts(archive);
    expect(complete).toBe(chunks);
    expect(queued).toBe(chunks);
    // Semantic search only surfaces live chunks.
    expect((await archive.searchSemantic("Terse.")).every((hit) => hit.mode === "semantic")).toBe(true);
    archive.close();
  });

  it("cleans persisted orphan rows from a previous interrupted sync", async () => {
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-issue-9-upgrade-"));
    const archivePath = join(root, "archive.sqlite");
    const archive = new Archive(archivePath);
    await archive.sync([message("Current content.")]);
    await archive.indexSemantic();
    // Inject orphan rows that simulate an interrupted sync crash
    archive.db.prepare("INSERT OR REPLACE INTO embedding_queue (chunk_id, content_hash, state, attempts) VALUES (?, ?, ?, ?)")
      .run("stale-chunk", "stale-hash", "pending", 0);
    archive.close();

    // Reopening cleans orphans: the queue and vector table hold only live chunks
    const reopened = new Archive(archivePath);
    await reopened.indexSemantic();
    expect(counts(reopened)).toEqual({ chunks: 1, queued: 1, complete: 1 });
    expect(await reopened.searchSemantic("Current content.")).toHaveLength(1);
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  });
});
