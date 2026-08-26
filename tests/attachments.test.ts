import { describe, expect, it } from "vitest";
import { Archive } from "../src/archive.js";

describe("attachment metadata", () => {
  it("lists metadata without exposing file contents by default", async () => {
    const archive = new Archive();
    await archive.sync([{
      accountId: "a", mailbox: "INBOX", providerKey: "p", messageId: "m",
      threadId: "t", subject: "Attachment", from: "a@example.com", to: [], cc: [],
      date: "2026-08-26T00:00:00Z", text: "body",
      attachments: [{ name: "../../secret.txt", mimeType: "text/plain", size: 10, text: "safe extracted text" }],
    }]);
    expect(archive.listAttachments("a:m")).toMatchObject([
      { name: "../../secret.txt", extractedText: "safe extracted text" },
    ]);
    archive.close();
  });
});
