import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureSource } from "../src/source.js";

describe("fixture source", () => {
  it("loads deterministic messages", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "mailcrawl-fixture-")), "messages.json");
    await writeFile(path, JSON.stringify([{ accountId: "a", mailbox: "INBOX", providerKey: "1", subject: "x", from: "a", to: [], cc: [], date: "2026-01-01T00:00:00Z", text: "body" }]));
    await expect(new FixtureSource(path).list()).resolves.toHaveLength(1);
  });

  it("preserves classification metadata from fixtures", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "mailcrawl-classification-fixture-")), "messages.json");
    await writeFile(path, JSON.stringify([{
      accountId: "gmail", mailbox: "INBOX", providerKey: "1", subject: "x",
      from: "a", to: [], cc: [], date: "2026-01-01T00:00:00Z", text: "body",
      labels: ["CLIENT_PROJECT"], flags: ["\\Seen"], classifications: ["CATEGORY_PRIMARY"],
    }]));
    const [message] = await new FixtureSource(path).list();
    expect(message.labels).toEqual(["CLIENT_PROJECT"]);
    expect(message.flags).toEqual(["\\Seen"]);
    expect(message.classifications).toEqual(["CATEGORY_PRIMARY"]);
  });
});
