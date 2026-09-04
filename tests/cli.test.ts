import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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

      expect(output.semantic.status).toBe("missing");
      expect(output.recommendation).toBe("run sync, then index before semantic search");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("reports an empty data directory without opening SQLite", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mailcrawl-cli-status-"));
    try {
      const result = await run("node", ["dist/cli/index.js", "--data-dir", dataDir, "status", "--json"]);
      expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
        archive: join(dataDir, "archive.sqlite"),
        archivePresent: false,
      }));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("supports the documented status, embed, repair all, and fts commands", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mailcrawl-cli-contract-"));
    try {
      const cli = ["dist/cli/index.js", "--data-dir", dataDir];
      const environment = { ...process.env, MAILCRAWL_EMBEDDER: "mock" };
      const sync = await run("node", [...cli, "sync", "--source", "fixture", "--fixture", "tests/fixtures/messages.json", "--json"], { env: environment });
      expect(JSON.parse(sync.stdout)).toMatchObject({ added: 2 });

      const status = await run("node", [...cli, "status", "--json"], { env: environment });
      expect(JSON.parse(status.stdout)).toMatchObject({ archivePresent: true, messageCount: 2, chunkCount: 2, fts: { status: "healthy", rows: 2 } });

      const embed = await run("node", [...cli, "embed", "--json"], { env: environment });
      expect(JSON.parse(embed.stdout)).toMatchObject({ embedded: 2 });

      const repair = await run("node", [...cli, "repair", "--all", "--json"], { env: environment });
      expect(JSON.parse(repair.stdout)).toMatchObject({ fts: { status: "repaired" }, semantic: expect.any(Object) });

      const search = await run("node", [...cli, "search", "--mode", "fts", "--json", "renewal"], { env: environment });
      expect(JSON.parse(search.stdout)).toEqual(expect.arrayContaining([
        expect.objectContaining({ mode: "bm25" }),
      ]));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps malformed commands as nonzero failures", async () => {
    await expect(run("node", ["dist/cli/index.js", "not-a-command"])).rejects.toMatchObject({ code: 1 });
  });

  it("rejects an unsupported sync source before invoking Himalaya", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mailcrawl-cli-source-"));
    try {
      await expect(run("node", ["dist/cli/index.js", "--data-dir", dataDir, "sync", "--source", "typo", "--json"]))
        .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("unsupported source: typo") });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
