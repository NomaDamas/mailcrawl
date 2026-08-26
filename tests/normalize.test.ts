import { describe, expect, it } from "vitest";
import { buildChunks } from "../src/chunk.js";
import { normalizeMessage } from "../src/normalize.js";

describe("email normalization and chunks", () => {
  it("separates latest authored text from quoted replies", async () => {
    const message = await normalizeMessage({
      accountId: "a",
      mailbox: "INBOX",
      providerKey: "p1",
      subject: "Re: Contract",
      from: "a@example.com",
      to: ["b@example.com"],
      cc: [],
      date: "2026-08-26T10:00:00Z",
      text: "New condition.\n\nOn Tue, Bob wrote:\n> Old condition.",
    });
    expect(message.latestText).toBe("New condition.");
    expect(message.quotedText).toContain("Old condition.");
    expect(buildChunks(message).map((chunk) => chunk.section)).toEqual(["latest", "quoted"]);
  });

  it("keeps chunk ids stable for identical normalized content", async () => {
    const input = {
      accountId: "a",
      mailbox: "INBOX",
      providerKey: "p1",
      subject: "Contract",
      from: "a@example.com",
      to: ["b@example.com"],
      cc: [],
      date: "2026-08-26T10:00:00Z",
      text: "Same body",
    };
    const first = buildChunks(await normalizeMessage(input));
    const second = buildChunks(await normalizeMessage(input));
    expect(second.map((chunk) => chunk.chunkId)).toEqual(first.map((chunk) => chunk.chunkId));
  });
});
