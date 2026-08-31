import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "../src/archive.js";

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

const message = (text: string) => ({
  accountId: "gmail",
  mailbox: "INBOX",
  providerKey: "provider-1",
  messageId: "message-1",
  threadId: "thread-1",
  subject: "Contract renewal",
  from: "alice@example.com",
  to: ["bob@example.com"],
  cc: [],
  date: "2026-08-26T10:00:00Z",
  text,
});

describe("issues 7-9", () => {
  it("does not initialize the embedder when a persisted index has no pending chunks", async () => {
    createEmbedder.mockClear();
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-issue-7-"));
    const path = join(root, "archive.db");
    const first = new Archive(path);
    await first.sync([message("Stable content.")]);
    await first.indexSemantic();
    first.close();

    const second = new Archive(path);
    await second.sync([message("Stable content.")]);
    const report = await second.indexSemantic();
    second.close();
    rmSync(root, { recursive: true, force: true });

    expect(report).toMatchObject({ embedded: 0, reused: 1 });
    expect(createEmbedder).toHaveBeenCalledTimes(1);
  });
});
