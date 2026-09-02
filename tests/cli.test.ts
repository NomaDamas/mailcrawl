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

      expect(output.semantic.status).toBe("stale");
      expect(output.recommendation).toBe("run sync, then index before semantic search");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
