import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("Vercel Agent Skill", () => {
  it("provides a discoverable skill with valid front matter", async () => {
    const document = await readFile("skills/mailcrawl/SKILL.md", "utf8");
    const normalized = document.replace(/\r\n/gu, "\n");
    expect(normalized).toMatch(/^---\n/u);
    expect(normalized).toMatch(/\nname:\s*mailcrawl\s*\n/u);
    expect(normalized).toMatch(/\ndescription:\s*.+\n/u);
    expect(normalized).toContain("\n---\n");
    expect(normalized).toContain("mailcrawl sync");
    expect(normalized).toContain("mailcrawl search");
    expect(normalized).toContain("mailcrawl doctor");
  });
});
