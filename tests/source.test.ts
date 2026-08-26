import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { FixtureSource } from "../src/source.js";

describe("fixture source", () => {
  it("loads deterministic messages", async () => {
    const path = "/tmp/mailcrawl-fixture.json";
    await writeFile(path, JSON.stringify([{ accountId: "a", mailbox: "INBOX", providerKey: "1", subject: "x", from: "a", to: [], cc: [], date: "2026-01-01T00:00:00Z", text: "body" }]));
    await expect(new FixtureSource(path).list()).resolves.toHaveLength(1);
  });
});
