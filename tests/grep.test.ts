import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Archive } from "../src/archive.js";
import type { MailMessage } from "../src/types.js";

const run = promisify(execFile);

function sampleMessages(): MailMessage[] {
  return [
    {
      accountId: "work",
      mailbox: "INBOX",
      providerKey: "msg-1",
      messageId: "m-1",
      threadId: "t-1",
      subject: "Invoice INV-2026-00421 ready",
      from: "billing@vendor.example",
      to: ["alice@acme.example"],
      cc: [],
      date: "2026-08-10T09:00:00Z",
      text: "Hello Alice,\nLine before token.\nPlease reference INV-2026-00421 on wire transfers.\nLine after token.\nThanks!",
    },
    {
      accountId: "work",
      mailbox: "INBOX",
      providerKey: "msg-2",
      messageId: "m-2",
      threadId: "t-2",
      subject: "Build alert",
      from: "ci@acme.example",
      to: ["alice@acme.example"],
      cc: [],
      date: "2026-08-11T10:00:00Z",
      text: "Lowercase inv-2026-00421 mentioned in test log.\nFailure code: ERR_503_GATEWAY.",
      attachments: [
        {
          name: "report.pdf",
          mimeType: "application/pdf",
          text: "Extracted PDF text with serial SERIAL-9988-XY.",
        },
      ],
    },
    {
      accountId: "personal",
      mailbox: "Archive",
      providerKey: "msg-3",
      messageId: "m-3",
      threadId: "t-3",
      subject: "Receipt",
      from: "shop@store.example",
      to: ["alice@personal.example"],
      cc: [],
      date: "2026-08-12T12:00:00Z",
      text: "Order ERR_503_GATEWAY confirmed.",
    },
  ];
}

describe("Archive.grep", () => {
  it("matches exact literal substrings, respects ignoreCase, and includes context lines", async () => {
    const archive = new Archive(":memory:");
    try {
      await archive.sync(sampleMessages());

      const exact = archive.grep("INV-2026-00421", { literal: true, context: 1 });
      expect(exact.length).toBeGreaterThanOrEqual(1);
      expect(exact.every((hit) => hit.accountId === "work")).toBe(true);
      expect(exact.every((hit) => hit.mode === "grep")).toBe(true);
      const bodyHit = exact.find((hit) => hit.line.includes("Please reference INV-2026-00421"));
      expect(bodyHit).toBeDefined();
      expect(bodyHit!.snippet).toContain("Line before token.");
      expect(bodyHit!.snippet).toContain("Line after token.");
      expect(bodyHit!.lineNumber).toBeGreaterThanOrEqual(1);

      const ci = archive.grep("INV-2026-00421", { literal: true, ignoreCase: true });
      const msgIds = new Set(ci.map((hit) => hit.messageId));
      expect(msgIds.size).toBe(2);
    } finally {
      archive.close();
    }
  });

  it("supports regex matching, attachment text matching, and metadata filters", async () => {
    const archive = new Archive(":memory:");
    try {
      await archive.sync(sampleMessages());

      const regexHits = archive.grep("(ERR_\\d+_GATEWAY|SERIAL-\\d+-XY)");
      expect(regexHits.length).toBe(3);
      expect(regexHits.some((hit) => hit.line.includes("SERIAL-9988-XY"))).toBe(true);

      const filtered = archive.grep("ERR_503_GATEWAY", {
        literal: true,
        filters: { accountId: "work", mailbox: "INBOX" },
      });
      expect(filtered.length).toBe(1);
      expect(filtered[0]!.accountId).toBe("work");
      expect(filtered[0]!.from).toBe("ci@acme.example");
    } finally {
      archive.close();
    }
  });

  it("rejects empty pattern or invalid regex cleanly", async () => {
    const archive = new Archive(":memory:");
    try {
      await archive.sync(sampleMessages());
      expect(() => archive.grep("")).toThrow(/empty/i);
      expect(() => archive.grep("[unclosed")).toThrow(/invalid/i);
    } finally {
      archive.close();
    }
  });
});

describe("CLI grep command", () => {
  it("runs mailcrawl grep --json and search --mode grep --json", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "mailcrawl-cli-grep-"));
    try {
      const cli = ["dist/cli/index.js", "--data-dir", dataDir];
      await run("node", [...cli, "sync", "--source", "fixture", "--fixture", "tests/fixtures/messages.json"]);

      const res = await run("node", [...cli, "grep", "--literal", "--ignore-case", "--json", "renewal"]);
      const hits = JSON.parse(res.stdout) as Array<{ mode: string; line: string; lineNumber: number }>;
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.mode === "grep")).toBe(true);
      expect(hits.every((h) => typeof h.lineNumber === "number" && h.lineNumber >= 1)).toBe(true);

      const resViaSearch = await run("node", [...cli, "search", "--mode", "grep", "--json", "renewal"]);
      const hitsViaSearch = JSON.parse(resViaSearch.stdout) as Array<{ mode: string }>;
      expect(hitsViaSearch.length).toBeGreaterThan(0);
      expect(hitsViaSearch.every((h) => h.mode === "grep")).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});
