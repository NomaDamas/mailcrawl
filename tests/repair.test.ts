import { describe, expect, it } from "vitest";
import { Archive } from "../src/archive.js";

describe("repair", () => {
  it("rebuilds FTS rows from archive chunks", async () => {
    const archive = new Archive();
    await archive.sync([{
      accountId: "a", mailbox: "INBOX", providerKey: "p", messageId: "m",
      threadId: "t", subject: "Repair", from: "a@example.com", to: [], cc: [],
      date: "2026-08-26T00:00:00Z", text: "repairable text",
    }]);
    archive.db.exec("DELETE FROM chunks_fts");
    expect(await archive.searchBm25("repairable")).toHaveLength(0);
    expect(archive.repairFts().rows).toBe(1);
    expect(await archive.searchBm25("repairable")).toHaveLength(1);
    archive.close();
  });

  it("keeps multilingual index state when repairing the base FTS table", async () => {
    const archive = new Archive();
    await archive.sync([{
      accountId: "a", mailbox: "INBOX", providerKey: "p", messageId: "m",
      threadId: "t", subject: "갱신", from: "a@example.com", to: [], cc: [],
      date: "2026-08-26T00:00:00Z", text: "계약 갱신",
    }]);
    const metadataBefore = archive.db.prepare("SELECT version FROM lexical_index_meta WHERE id = 1").get();
    const languageRowsBefore = archive.db.prepare("SELECT COUNT(*) AS count FROM chunks_fts_ko").get() as { count: number };

    archive.db.exec("DELETE FROM chunks_fts");
    expect(archive.repairFts().rows).toBe(1);

    expect(archive.db.prepare("SELECT version FROM lexical_index_meta WHERE id = 1").get()).toEqual(metadataBefore);
    expect((archive.db.prepare("SELECT COUNT(*) AS count FROM chunks_fts_ko").get() as { count: number }).count)
      .toBe(languageRowsBefore.count);
    await expect(archive.searchBm25("갱신")).resolves.toHaveLength(1);
    archive.close();
  });
});
