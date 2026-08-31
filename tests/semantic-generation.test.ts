import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "../src/archive.js";

const { failPointerPublication } = vi.hoisted(() => ({ failPointerPublication: { value: false } }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (source: Parameters<typeof actual.renameSync>[0], target: Parameters<typeof actual.renameSync>[1]) => {
      if (failPointerPublication.value && String(source).includes(".CURRENT.") && String(target).endsWith("/CURRENT")) {
        throw new Error("injected CURRENT publication failure");
      }
      return actual.renameSync(source, target);
    },
  };
});

describe("semantic generations", () => {
  it("restores SQLite vectors and queue rows when CURRENT publication fails", async () => {
    const archive = new Archive();
    await archive.sync([{
      accountId: "a", mailbox: "INBOX", providerKey: "p", messageId: "m",
      threadId: "t", subject: "Generation", from: "a@example.com", to: [], cc: [],
      date: "2026-08-26T00:00:00Z", text: "stable vector",
    }, {
      accountId: "a", mailbox: "INBOX", providerKey: "p2", messageId: "m2",
      threadId: "t2", subject: "Unchanged", from: "a@example.com", to: [], cc: [],
      date: "2026-08-26T00:00:00Z", text: "unchanged vector",
    }]);
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-semantic-"));
    const first = await archive.indexSemanticGeneration(root);
    await archive.sync([{
      accountId: "a", mailbox: "INBOX", providerKey: "p", messageId: "m",
      threadId: "t", subject: "Generation", from: "a@example.com", to: [], cc: [],
      date: "2026-08-26T00:00:00Z", text: "changed vector",
    }]);
    const vectorsBefore = archive.db.prepare("SELECT * FROM semantic_vectors ORDER BY chunk_id").all();
    const queueBefore = archive.db.prepare("SELECT * FROM embedding_queue ORDER BY chunk_id").all();
    failPointerPublication.value = true;

    await expect(archive.indexSemanticGeneration(root)).rejects.toThrow("injected CURRENT publication failure");

    expect(archive.db.prepare("SELECT * FROM semantic_vectors ORDER BY chunk_id").all()).toEqual(vectorsBefore);
    expect(archive.db.prepare("SELECT * FROM embedding_queue ORDER BY chunk_id").all()).toEqual(queueBefore);
    expect(archive.semanticGeneration(root).generation).toBe(first.generation);
    failPointerPublication.value = false;
    archive.close();
  });

  it("publishes a generation and preserves the pointer on staging failure", async () => {
    const archive = new Archive();
    await archive.sync([{
      accountId: "a", mailbox: "INBOX", providerKey: "p", messageId: "m",
      threadId: "t", subject: "Generation", from: "a@example.com", to: [], cc: [],
      date: "2026-08-26T00:00:00Z", text: "stable vector",
    }]);
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-semantic-"));
    const first = await archive.indexSemanticGeneration(root);
    expect(archive.semanticGeneration(root).generation).toBe(first.generation);
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "not a directory");
    await expect(archive.indexSemanticGeneration(blocked)).rejects.toThrow();
    expect(archive.semanticGeneration(root).generation).toBe(first.generation);
    archive.close();
  });
});
