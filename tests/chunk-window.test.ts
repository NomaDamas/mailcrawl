import { describe, expect, it } from "vitest";
import { CHUNK_MAX_CHARS, CHUNK_OVERLAP_CHARS, buildChunks, splitText } from "../src/chunk.js";
import type { NormalizedMessage } from "../src/types.js";

function message(latestText: string): NormalizedMessage {
  return {
    accountId: "a", mailbox: "INBOX", messageId: "m1", threadId: "t1", subject: "s", from: "a@example.com", to: [], cc: [],
    date: "2026-08-26T10:00:00Z", latestText, quotedText: "", attachments: [],
  } as unknown as NormalizedMessage;
}

describe("sliding-window chunking", () => {
  it("keeps a text within the window as one chunk", () => {
    expect(splitText("짧은 메일입니다.")).toEqual(["짧은 메일입니다."]);
    const exact = "가".repeat(CHUNK_MAX_CHARS);
    expect(splitText(exact)).toEqual([exact]);
  });

  it("never emits a window over the limit, even for one unbroken paragraph", () => {
    const text = "가나다라마바사 아자차카타파하 ".repeat(400);
    const windows = splitText(text);
    expect(windows.length).toBeGreaterThan(1);
    for (const window of windows) expect(window.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
  });

  it("overlaps each window with the end of the previous one and loses no text", () => {
    // Distinct words so an overlap can only come from the windowing.
    const words = Array.from({ length: 1500 }, (_, index) => `단어${index}`);
    const text = words.join(" ");
    const windows = splitText(text);
    expect(windows.length).toBeGreaterThan(1);
    for (let index = 1; index < windows.length; index += 1) {
      const previous = windows[index - 1]!;
      const current = windows[index]!;
      const head = current.slice(0, 20);
      const at = previous.lastIndexOf(head);
      expect(at, `window ${index} starts inside window ${index - 1}`).toBeGreaterThanOrEqual(0);
      expect(previous.length - at).toBeGreaterThanOrEqual(Math.min(CHUNK_OVERLAP_CHARS / 2, previous.length));
    }
    const seen = new Set(windows.join(" ").split(/\s+/));
    for (const word of words) expect(seen.has(word)).toBe(true);
  });

  it("cuts at whitespace when it can, so a word is not split in the middle", () => {
    const text = Array.from({ length: 1200 }, (_, index) => `word${index}`).join(" ");
    for (const window of splitText(text)) {
      expect(window).toMatch(/^word\d+/);
      expect(window).toMatch(/word\d+$/);
    }
  });

  it("is deterministic and keeps chunk ids stable across runs", () => {
    const text = "가나다라마바사 아자차카타파하 ".repeat(400);
    expect(splitText(text)).toEqual(splitText(text));
    const first = buildChunks(message(text)).map((chunk) => chunk.chunkId);
    const second = buildChunks(message(text)).map((chunk) => chunk.chunkId);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
  });

  it("splits paragraphs first and only windows the ones that are too long", () => {
    const long = "가나다라마바사 ".repeat(500);
    const windows = splitText(`첫 문단입니다.\n\n${long}\n\n마지막 문단입니다.`);
    expect(windows[0]).toBe("첫 문단입니다.");
    expect(windows.at(-1)).toBe("마지막 문단입니다.");
    expect(windows.length).toBeGreaterThan(3);
  });

  it("numbers the windows of one message in order", () => {
    const chunks = buildChunks(message("가나다라마바사 아자차카타파하 ".repeat(400)));
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(chunks.map((_, index) => index));
  });
});
