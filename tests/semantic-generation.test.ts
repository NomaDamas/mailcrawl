import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "../src/archive.js";

describe("semantic generations", () => {
  it("publishes a generation and preserves the pointer on staging failure", async () => {
    const archive = new Archive();
    await archive.sync([{
      accountId: "a", mailbox: "INBOX", providerKey: "p", messageId: "m",
      threadId: "t", subject: "Generation", from: "a@example.com", to: [], cc: [],
      date: "2026-08-26T00:00:00Z", text: "stable vector",
    }]);
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-semantic-"));
    const first = archive.indexSemanticGeneration(root);
    expect(archive.semanticGeneration(root).generation).toBe(first.generation);
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "not a directory");
    expect(() => archive.indexSemanticGeneration(blocked)).toThrow();
    expect(archive.semanticGeneration(root).generation).toBe(first.generation);
    archive.close();
  });
});
