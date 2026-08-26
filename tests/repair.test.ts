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
    expect(archive.searchBm25("repairable")).toHaveLength(0);
    expect(archive.repairFts().rows).toBe(1);
    expect(archive.searchBm25("repairable")).toHaveLength(1);
    archive.close();
  });
});
