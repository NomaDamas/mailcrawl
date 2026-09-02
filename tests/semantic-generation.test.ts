import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "../src/archive.js";

describe("semantic generations", () => {
  it("retains the current and previous generations while pruning only generated directories", async () => {
    const archive = new Archive();
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-semantic-retention-"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));
    try {
      await archive.sync([{
        accountId: "a", mailbox: "INBOX", providerKey: "p", messageId: "m",
        threadId: "t", subject: "Generation", from: "a@example.com", to: [], cc: [],
        date: "2026-08-26T00:00:00Z", text: "first vector",
      }]);
      const first = await archive.indexSemanticGeneration(root);
      writeFileSync(join(root, "unrelated.txt"), "keep me");
      mkdirSync(join(root, "generations", "unrelated"));
      mkdirSync(join(root, "generations", `.${first.generation}.staging`));

      vi.advanceTimersByTime(1);
      await archive.sync([{
        accountId: "a", mailbox: "INBOX", providerKey: "p", messageId: "m",
        threadId: "t", subject: "Generation", from: "a@example.com", to: [], cc: [],
        date: "2026-08-26T00:00:00Z", text: "second vector",
      }]);
      const second = await archive.indexSemanticGeneration(root);
      expect(existsSync(join(root, "generations", first.generation))).toBe(true);
      expect(JSON.parse(readFileSync(join(root, "generations", first.generation, "manifest.json"), "utf8")).vectors).toHaveLength(1);

      vi.advanceTimersByTime(1);
      await archive.sync([{
        accountId: "a", mailbox: "INBOX", providerKey: "p", messageId: "m",
        threadId: "t", subject: "Generation", from: "a@example.com", to: [], cc: [],
        date: "2026-08-26T00:00:00Z", text: "third vector",
      }]);
      const third = await archive.indexSemanticGeneration(root);

      expect(existsSync(join(root, "generations", first.generation))).toBe(false);
      expect(existsSync(join(root, "generations", second.generation))).toBe(true);
      expect(existsSync(join(root, "generations", third.generation))).toBe(true);
      expect(readFileSync(join(root, "CURRENT"), "utf8").trim()).toBe(third.generation);
      expect(readFileSync(join(root, "unrelated.txt"), "utf8")).toBe("keep me");
      expect(readdirSync(join(root, "generations"))).toEqual(expect.arrayContaining([
        second.generation, third.generation, "unrelated", `.${first.generation}.staging`,
      ]));
      expect(readdirSync(join(root, "generations")).filter((name) => /^gen-[0-9a-f]{16}-[0-9]+$/.test(name))).toHaveLength(2);
    } finally {
      archive.close();
      rmSync(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("preserves the current pointer when staging cannot be created", async () => {
    const archive = new Archive();
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-semantic-"));
    try {
      await archive.sync([{
        accountId: "a", mailbox: "INBOX", providerKey: "p", messageId: "m",
        threadId: "t", subject: "Generation", from: "a@example.com", to: [], cc: [],
        date: "2026-08-26T00:00:00Z", text: "stable vector",
      }]);
      const first = await archive.indexSemanticGeneration(root);
      expect(archive.semanticGeneration(root).generation).toBe(first.generation);
      const blocked = join(root, "blocked");
      writeFileSync(blocked, "not a directory");
      await expect(archive.indexSemanticGeneration(blocked)).rejects.toThrow();
      expect(archive.semanticGeneration(root).generation).toBe(first.generation);
    } finally {
      archive.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
