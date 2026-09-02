import { describe, expect, it } from "vitest";
import { Archive } from "../src/archive.js";
import { scopedId } from "../src/util.js";
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
    expect(await archive.searchBm25("renewal", { from: "alice@example.com" })).toHaveLength(1);
    expect(await archive.searchBm25("renewal", { from: "other@example.com" })).toHaveLength(0);
    archive.close();
  });

  it("indexes vectors incrementally and performs semantic retrieval", async () => {
    const archive = new Archive();
    await archive.sync([message]);
    expect((await archive.indexSemantic()).embedded).toBe(1);
    expect((await archive.indexSemantic()).reused).toBe(1);
    expect(await archive.searchSemantic("renewal condition")).toHaveLength(1);
    archive.close();
  });

  it("merges lexical and semantic hits deterministically", async () => {
    const archive = new Archive();
    await archive.sync([message]);
    await archive.indexSemantic();
    expect(await archive.searchHybrid("renewal")).toMatchObject([{ mode: "hybrid", messageId: scopedId("gmail", "INBOX", "message-1") }]);
    archive.close();
  });

  it("uses reciprocal rank fusion for hybrid scores", async () => {
    const archive = new Archive();
    await archive.sync([
      message,
      { ...message, providerKey: "provider-2", messageId: "message-2", text: "renewal" },
    ]);
    await archive.indexSemantic();
    const hits = await archive.searchHybrid("renewal", {}, 2);
    expect(hits).toHaveLength(2);
    expect(hits.every((hit) => hit.mode === "hybrid")).toBe(true);
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
    archive.close();
  });

  it("indexes extracted attachment text with the parent message", async () => {
    const archive = new Archive();
    await archive.sync([{ ...message, attachments: [{ name: "terms.txt", mimeType: "text/plain", text: "termination clause" }] }]);
    expect(await archive.searchBm25("termination")).toHaveLength(1);
    archive.close();
  });

  it("keeps unchanged chunks stable after an append to the same thread", async () => {
    const archive = new Archive();
    await archive.sync([message]);
    const before = (await archive.searchBm25("renewal"))[0].chunkId;
    await archive.sync([{ ...message, providerKey: "provider-2", messageId: "message-2", date: "2026-08-26T11:00:00Z", text: "Please approve the renewal." }]);
    const hits = await archive.searchBm25("renewal");
    expect(hits.map((hit) => hit.chunkId)).toContain(before);
    expect(hits).toHaveLength(2);
    archive.close();
  });

  it("keeps identical provider ids isolated across accounts and mailboxes", async () => {
    const archive = new Archive();
    await archive.sync([
      { ...message, accountId: "gmail", mailbox: "INBOX" },
      { ...message, accountId: "gmail", mailbox: "Archive" },
      { ...message, accountId: "khu", mailbox: "INBOX" },
    ]);
    expect(await archive.searchBm25("renewal")).toHaveLength(3);
    expect(await archive.searchBm25("renewal", { accountId: "gmail", mailbox: "Archive" })).toHaveLength(1);
    archive.close();
  });

  it("keeps colon-containing identity parts unambiguous", async () => {
    const archive = new Archive();
    await archive.sync([
      { ...message, accountId: "a:b", mailbox: "INBOX", providerKey: "c", messageId: "d" },
      { ...message, accountId: "a", mailbox: "b:INBOX", providerKey: "c", messageId: "d" },
    ]);
    expect(await archive.searchBm25("renewal")).toHaveLength(2);
    archive.close();
  });

  it("rejects duplicate identities in one snapshot", async () => {
    const archive = new Archive();
    await expect(archive.sync([message, message])).rejects.toThrow("duplicate message provider identity");
    archive.close();
  });

  it("rejects messages without a provider identity", async () => {
    const archive = new Archive();
    await expect(archive.sync([{ ...message, providerKey: "" }])).rejects.toThrow("provider identity is required");
    archive.close();
  });

  it("rejects a provider identity that would overwrite another message", async () => {
    const archive = new Archive();
    await archive.sync([message]);
    await expect(archive.sync([{ ...message, messageId: "message-2" }])).rejects.toThrow("another message identity");
    expect(archive.getMessage(scopedId("gmail", "INBOX", "message-1"))?.providerKey).toBe(scopedId("gmail", "INBOX", "provider-1"));
    archive.close();
  });

  it("removes only the excluded message in its mailbox", async () => {
    const archive = new Archive();
    await archive.sync([
      { ...message, mailbox: "INBOX", text: "keep this renewal" },
      { ...message, mailbox: "Archive", text: "remove this renewal" },
    ]);
    const report = await archive.sync([
      { ...message, mailbox: "INBOX", text: "keep this renewal" },
      { ...message, mailbox: "Archive", classifications: ["CATEGORY_SPAM"], text: "remove this renewal" },
    ]);
    expect(report.excluded).toBe(1);
    expect(await archive.searchBm25("renewal")).toHaveLength(1);
    expect(await archive.searchBm25("renewal", { mailbox: "INBOX" })).toHaveLength(1);
    expect(await archive.searchBm25("renewal", { mailbox: "Archive" })).toHaveLength(0);
    archive.close();
  });

  it("walks earlier and later messages around a search result", async () => {
    const archive = new Archive();
    await archive.sync([
      message,
      { ...message, providerKey: "provider-2", messageId: "message-2", date: "2026-08-26T11:00:00Z", text: "Second reply" },
      { ...message, providerKey: "provider-3", messageId: "message-3", date: "2026-08-26T12:00:00Z", text: "Final reply" },
    ]);
    const context = archive.getThreadContext(scopedId("gmail", "INBOX", "thread-1"), scopedId("gmail", "INBOX", "message-2"));
    expect(context.previous).toHaveLength(1);
    expect(context.current?.text).toBe("Second reply");
    expect(context.next).toHaveLength(1);
    archive.close();
  });

  it("excludes spam and promotions from every index by default", async () => {
    const archive = new Archive();
    const report = await archive.sync([
      { ...message, classifications: ["CATEGORY_SPAM"], text: "secret spam renewal" },
      { ...message, providerKey: "provider-2", messageId: "message-2", classifications: ["CATEGORY_PROMOTIONS"], text: "promotion renewal" },
      { ...message, providerKey: "provider-3", messageId: "message-3", labels: ["CLIENT_PROJECT"], text: "project renewal" },
    ]);
    await archive.indexSemantic();
    expect(report.excluded).toBe(2);
    expect(report.excludedByReason).toEqual({ spam: 1, promotions: 1 });
    expect(archive.getMessage(scopedId("gmail", "INBOX", "message-1"))).toBeUndefined();
    expect(await archive.searchBm25("renewal")).toHaveLength(1);
    expect(await archive.searchSemantic("renewal")).toHaveLength(1);
    archive.close();
  });

  it("allows callers to disable or customize classification exclusions", async () => {
    const archive = new Archive();
    const report = await archive.sync([{
      ...message, classifications: ["CATEGORY_SPAM"], labels: ["CLIENT_PROJECT"],
    }], { excludedCategories: [] });
    expect(report.excluded).toBe(0);
    expect(archive.getMessage(scopedId("gmail", "INBOX", "message-1"))?.categories).toContain("spam");
    expect(await archive.searchBm25("renewal")).toHaveLength(1);
    archive.close();
  });

});
