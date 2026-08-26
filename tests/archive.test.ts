import { describe, expect, it } from "vitest";
import { Archive } from "../src/archive.js";
import type { MailMessage } from "../src/types.js";

const message: MailMessage = {
  accountId: "gmail",
  mailbox: "INBOX",
  providerKey: "provider-1",
  messageId: "message-1",
  threadId: "thread-1",
  subject: "Contract renewal",
  from: "alice@example.com",
  to: ["bob@example.com"],
  cc: [],
  date: "2026-08-26T10:00:00Z",
  text: "The contract renewal condition is ready.",
};

describe("archive", () => {
  it("syncs idempotently and searches with sender filters", async () => {
    const archive = new Archive();
    const first = await archive.sync([message]);
    const second = await archive.sync([message]);
    expect(first.added).toBe(1);
    expect(second.unchanged).toBe(1);
    expect(archive.searchBm25("renewal", { from: "alice@example.com" })).toHaveLength(1);
    expect(archive.searchBm25("renewal", { from: "other@example.com" })).toHaveLength(0);
    archive.close();
  });
});
