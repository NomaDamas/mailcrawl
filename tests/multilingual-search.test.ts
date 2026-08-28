import { describe, expect, it } from "vitest";
import { Archive } from "../src/archive.js";
import type { MailMessage } from "../src/types.js";

const messages: MailMessage[] = [
  { accountId: "test", mailbox: "INBOX", providerKey: "en", messageId: "en", threadId: "en", subject: "Contract renewal", from: "en@example.com", to: [], cc: [], date: "2026-08-28T00:00:00Z", text: "Please review the contract renewal." },
  { accountId: "test", mailbox: "INBOX", providerKey: "ko", messageId: "ko", threadId: "ko", subject: "계약 갱신", from: "ko@example.com", to: [], cc: [], date: "2026-08-28T00:00:00Z", text: "계약 갱신 조건을 검토해 주세요." },
  { accountId: "test", mailbox: "INBOX", providerKey: "ja", messageId: "ja", threadId: "ja", subject: "契約 更新", from: "ja@example.com", to: [], cc: [], date: "2026-08-28T00:00:00Z", text: "契約 更新 の 条件を確認してください。" },
  { accountId: "test", mailbox: "INBOX", providerKey: "zh", messageId: "zh", threadId: "zh", subject: "合同 更新", from: "zh@example.com", to: [], cc: [], date: "2026-08-28T00:00:00Z", text: "请确认 合同 更新 条件。" },
  { accountId: "test", mailbox: "INBOX", providerKey: "ar", messageId: "ar", threadId: "ar", subject: "تجديد العقد", from: "ar@example.com", to: [], cc: [], date: "2026-08-28T00:00:00Z", text: "يرجى مراجعة تجديد العقد." },
];

describe("multilingual indexing and search", () => {
  it.each([
    ["contract renewal", "en"],
    ["계약 갱신", "ko"],
    ["契約 更新", "ja"],
    ["合同 更新", "zh"],
    ["العقد", "ar"],
  ])("indexes and retrieves %s", async (query, language) => {
    const archive = new Archive();
    await archive.sync(messages);
    const hits = await archive.searchBm25(query);
    expect(hits.some((hit) => hit.messageId === `test:${language}`)).toBe(true);
    archive.close();
  });
});
