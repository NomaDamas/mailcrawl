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

  it("indexes vectors incrementally and performs semantic retrieval", async () => {
    const archive = new Archive();
    await archive.sync([message]);
    expect(archive.indexSemantic().embedded).toBe(1);
    expect(archive.indexSemantic().reused).toBe(1);
    expect(archive.searchSemantic("renewal condition")).toHaveLength(1);
    archive.close();
  });

  it("merges lexical and semantic hits deterministically", async () => {
    const archive = new Archive();
    await archive.sync([message]);
    archive.indexSemantic();
    expect(archive.searchHybrid("renewal")).toMatchObject([{ mode: "hybrid", messageId: "gmail:message-1" }]);
    archive.close();
  });

  it("indexes extracted attachment text with the parent message", async () => {
    const archive = new Archive();
    await archive.sync([{ ...message, attachments: [{ name: "terms.txt", mimeType: "text/plain", text: "termination clause" }] }]);
    expect(archive.searchBm25("termination")).toHaveLength(1);
    archive.close();
  });

  it("keeps unchanged chunks stable after an append to the same thread", async () => {
    const archive = new Archive();
    await archive.sync([message]);
    const before = archive.searchBm25("renewal")[0].chunkId;
    await archive.sync([{ ...message, providerKey: "provider-2", messageId: "message-2", date: "2026-08-26T11:00:00Z", text: "Please approve the renewal." }]);
    const hits = archive.searchBm25("renewal");
    expect(hits.map((hit) => hit.chunkId)).toContain(before);
    expect(hits).toHaveLength(2);
    archive.close();
  });

  it("keeps identical provider ids isolated across accounts", async () => {
    const archive = new Archive();
    await archive.sync([
      { ...message, accountId: "gmail" },
      { ...message, accountId: "khu" },
    ]);
    expect(archive.searchBm25("renewal")).toHaveLength(2);
    expect(archive.searchBm25("renewal", { accountId: "gmail" })).toHaveLength(1);
    archive.close();
  });
});
