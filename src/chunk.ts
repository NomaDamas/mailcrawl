import type { Chunk, NormalizedMessage } from "./types.js";
import { hash, makeId } from "./util.js";

const MAX_CHARS = 2400;

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

function splitText(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const output: string[] = [];
  for (const paragraph of paragraphs.length ? paragraphs : [text.trim()]) {
    for (let start = 0; start < paragraph.length; start += MAX_CHARS) {
      output.push(paragraph.slice(start, start + MAX_CHARS).trim());
    }
  }
  return output.filter(Boolean);
}
