import { readFile } from "node:fs/promises";

const path = "skills/mailcrawl/SKILL.md";
const document = (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
const errors = [];

if (!document.startsWith("---\n")) errors.push("missing front matter start");
if (!/\nname:\s*mailcrawl\s*\n/.test(document)) errors.push("missing skill name");
if (!/\ndescription:\s*.+\n/.test(document)) errors.push("missing skill description");
if (!document.includes("\n---\n")) errors.push("missing front matter end");
for (const required of ["mailcrawl sync", "mailcrawl search", "mailcrawl doctor", "## Safety boundary"]) {
  if (!document.includes(required)) errors.push(`missing required content: ${required}`);
}
if (/[가-힣]/u.test(document)) errors.push("skill documentation must be English");

if (errors.length) {
  console.error(`${path}: ${errors.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log(`${path}: valid`);
}
