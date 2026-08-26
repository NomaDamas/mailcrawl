import { describe, expect, it } from "vitest";
import { normalizeMessage } from "../src/normalize.js";
import { buildChunks } from "../src/chunk.js";

describe("MIME attachment extraction", () => {
  it("extracts bounded text attachments and leaves binary content opaque", async () => {
    const message = await normalizeMessage({
      accountId: "a", mailbox: "INBOX", providerKey: "mime-1",
      subject: "Attachment", from: "a@example.com", to: [], cc: [],
      date: "2026-08-26T00:00:00Z",
      text: "",
      rawMime: [
        "From: a@example.com",
        "To: b@example.com",
        "Subject: Attachment",
        "MIME-Version: 1.0",
        "Content-Type: multipart/mixed; boundary=\"x\"",
        "",
        "--x",
        "Content-Type: text/plain",
        "",
        "See attached.",
        "--x",
        "Content-Type: text/plain",
        "Content-Disposition: attachment; filename=\"notes.txt\"",
        "",
        "Important attachment text.",
        "--x--",
      ].join("\r\n"),
    });
    expect(message.attachments?.[0]).toMatchObject({ name: "notes.txt", text: "Important attachment text." });
    expect(buildChunks(message).some((chunk) => chunk.section === "attachment")).toBe(true);
  });
});
