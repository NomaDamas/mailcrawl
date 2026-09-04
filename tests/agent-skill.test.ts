import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("Vercel Agent Skill", () => {
  it("provides a discoverable skill with valid front matter", async () => {
    const document = await readFile("skills/mailcrawl/SKILL.md", "utf8");
    expect(document).toMatch(/^---\r?\n/u);
    expect(document).toMatch(/\nname:\s*mailcrawl\s*\n/);
    expect(document).toMatch(/\ndescription:\s*.+\n/);
    expect(document).toContain("\n---\n");
    expect(document).toContain("mailcrawl sync");
    expect(document).toContain("mailcrawl search");
    expect(document).toContain("mailcrawl doctor");
  });
});
