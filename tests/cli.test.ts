import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

describe("CLI contract", () => {
  it("prints help", async () => {
    const result = await run("node", ["dist/cli/index.js", "--help"]);
    expect(result.stdout).toContain("mailcrawl");
  });

  it("recommends indexing when semantic generation is stale", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mailcrawl-cli-doctor-"));
    try {
      const result = await run("node", ["dist/cli/index.js", "--data-dir", dataDir, "doctor", "--json"]);
      const output = JSON.parse(result.stdout) as {
        semantic: { status: string };
        recommendation: string;
      };

      expect(output.semantic.status).toBe("stale");
      expect(output.recommendation).toBe("run sync, then index before semantic search");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("search:keyword returns lexical results without semantic indexing", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mailcrawl-cli-keyword-"));
    const fixture = join(dataDir, "messages.json");
    await writeFile(fixture, JSON.stringify([{
      accountId: "fixture",
      mailbox: "INBOX",
      providerKey: "keyword-1",
      subject: "Contract renewal",
      from: "alice@example.com",
      to: ["bob@example.com"],
      cc: [],
      date: "2026-08-26T10:00:00Z",
      text: "The contract renewal condition is ready.",
    }]));
    try {
      await run("node", ["dist/cli/index.js", "--data-dir", dataDir, "sync", "--source", "fixture", "--fixture", fixture]);
      const result = await run("node", ["dist/cli/index.js", "--data-dir", dataDir, "search:keyword", "--json", "renewal"]);
      const output = JSON.parse(result.stdout) as Array<{ mode: string }>;

      expect(output.length).toBeGreaterThan(0);
      expect(output.every((hit) => hit.mode === "bm25")).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
