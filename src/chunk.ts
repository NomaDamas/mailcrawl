import type { Chunk, NormalizedMessage } from "./types.js";
import { hash, makeId } from "./util.js";

/**
 * Largest chunk, in characters. Real Korean prose is about 1.6 characters per token, so 2000 characters stay
 * near 1300 tokens, inside the 2048-token context of the im-not-llm daemon's Qwen3-Embedding-0.6B. Text that
 * tokenizes worse (random hangul, digits, emoji) is handled by the embedder, which splits a rejected window.
 */
export const CHUNK_MAX_CHARS = 2000;
/** Characters each window repeats from the end of the previous one, so a sentence cut at a boundary stays whole in one window. */
export const CHUNK_OVERLAP_CHARS = 200;

export function buildChunks(message: NormalizedMessage): Chunk[] {
  const sections = [
    ["latest", message.latestText],
    ["quoted", message.quotedText],
    ["attachment", (message.attachments || []).map((a) => a.text || "").filter(Boolean).join("\n")],
  ] as const;
  const chunks: Chunk[] = [];
  for (const [section, text] of sections) {
    if (!text.trim()) continue;
    const parts = splitText(text);
    parts.forEach((part, ordinal) => {
      const chunkId = makeId(message.accountId, message.mailbox, message.messageId, section, String(ordinal), part);
      chunks.push({
        chunkId,
        accountId: message.accountId,
        mailbox: message.mailbox,
        messageId: message.messageId,
        threadId: message.threadId,
        section,
        ordinal,
        text: part,
        startedAt: message.date,
        endedAt: message.date,
        contentHash: hash(part),
      });
    });
  }
  return chunks;
}

/**
 * Paragraphs first; a paragraph longer than {@link CHUNK_MAX_CHARS} becomes sliding windows. A window ends at
 * the last whitespace inside the limit (a hard cut only when there is none) and the next one starts
 * {@link CHUNK_OVERLAP_CHARS} characters back, again at a whitespace boundary.
 */
export function splitText(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const output: string[] = [];
  for (const paragraph of paragraphs.length ? paragraphs : [text.trim()]) output.push(...slideWindows(paragraph));
  return output.filter(Boolean);
}

function slideWindows(paragraph: string): string[] {
  if (paragraph.length <= CHUNK_MAX_CHARS) return [paragraph];
  const windows: string[] = [];
  let start = 0;
  while (start < paragraph.length) {
    let end = Math.min(start + CHUNK_MAX_CHARS, paragraph.length);
    if (end < paragraph.length) {
      const space = paragraph.lastIndexOf(" ", end);
      // Only cut at whitespace when that still leaves the window most of its size.
      if (space > start + CHUNK_MAX_CHARS / 2) end = space;
    }
    windows.push(paragraph.slice(start, end).trim());
    if (end >= paragraph.length) break;
    let next = end - CHUNK_OVERLAP_CHARS;
    const boundary = paragraph.indexOf(" ", next);
    if (boundary !== -1 && boundary < end) next = boundary + 1;
    // Always move forward, or a window could repeat itself for ever.
    start = next > start ? next : end;
  }
  return windows;
}
