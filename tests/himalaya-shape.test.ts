import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureSource } from "../src/source.js";

describe("Himalaya envelope shape compatibility", () => {
  it("accepts hyphenated JSON envelope keys", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "mailcrawl-himalaya-shape-")), "messages.json");
    await writeFile(path, JSON.stringify([{
      accountId: "gmail", mailbox: "INBOX", providerKey: "57524",
      "message-id": "abc@example.com", subject: "Subject",
      from: "sender@example.com", to: ["recipient@example.com"], cc: [],
      date: "2026-08-26T00:00:00Z", text: "body",
    }]));
    const result = await new FixtureSource(path).list();
    expect(result[0].providerKey).toBe("57524");
  });
});
