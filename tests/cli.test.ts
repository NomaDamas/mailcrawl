import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

describe("CLI contract", () => {
  it("prints help", async () => {
    const result = await run("node", ["dist/cli/index.js", "--help"]);
    expect(result.stdout).toContain("mailcrawl");
  });
});
