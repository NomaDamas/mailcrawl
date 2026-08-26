import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("Agent Skill documentation", () => {
  it("contains the required operational and safety sections", async () => {
    const document = await readFile("skills/mailcrawl/SKILL.md", "utf8");
    for (const section of [
      "# mailcrawl",
      "## Installation and activation",
      "## Data and credential boundaries",
      "## Workflow",
      "## JSON contract",
      "## Safety boundary",
      "## Verification",
    ]) expect(document).toContain(section);
    expect(document).not.toMatch(/[가-힣]/u);
  });
});
