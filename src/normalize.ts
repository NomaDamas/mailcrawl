import { simpleParser, type ParsedMail } from "mailparser";
import type { AttachmentInput, MailMessage, NormalizedMessage } from "./types.js";
import { hash, makeId, normalizeSubject } from "./util.js";

/** Text-like attachments larger than this keep only their metadata. */
const MAX_ATTACHMENT_TEXT_BYTES = 1_000_000;

export async function normalizeMessage(input: MailMessage): Promise<NormalizedMessage> {
  let text = input.text || "";
  let html = input.html;
  let attachments = input.attachments;
  if (input.rawMime) {
    const parsed = await simpleParser(input.rawMime);
    text = parsed.text || "";
    html = typeof parsed.html === "string" ? parsed.html : undefined;
    attachments = parsedAttachments(parsed);
  }
  const { latest, quoted } = splitQuoted(text);
  const subject = input.subject.trim();
  const messageId = input.messageId || input.providerKey;
  const threadId = input.threadId || makeId(input.accountId, normalizeSubject(subject));
  const attachmentInputs = (attachments || []).map((attachment) => [
    attachment.name,
    attachment.mimeType,
    attachment.size ?? null,
    attachment.text ?? null,
    attachment.contentHash ?? null,
  ]);
  const normalizedHash = hash(JSON.stringify([
    subject, input.from, input.to, input.cc, latest, quoted,
    input.labels, input.flags, input.classifications,
    ...(attachmentInputs.length ? [attachmentInputs] : []),
  ]));
  const categories = [...new Set([
    ...(input.classifications || []),
    ...(input.labels || []),
    ...(input.flags || []),
  ].map(normalizeCategory).filter(Boolean))];
  return {
    ...input,
    messageId,
    threadId,
    html,
    attachments,
    normalizedSubject: normalizeSubject(subject),
    latestText: latest,
    quotedText: quoted,
    text: latest,
    normalizedHash,
    categories,
  };
}

/** Maps mailparser attachments to archive inputs; text bodies are kept only for bounded text parts. */
export function parsedAttachments(parsed: ParsedMail): AttachmentInput[] {
  return (parsed.attachments || []).map((attachment) => {
    const mimeType = attachment.contentType || "application/octet-stream";
    const content = attachment.content || Buffer.alloc(0);
    const textLike = mimeType.startsWith("text/") && content.length <= MAX_ATTACHMENT_TEXT_BYTES;
    return {
      name: attachment.filename || "unnamed",
      mimeType,
      size: attachment.size ?? content.length,
      contentHash: hash(content.toString("base64")),
      text: textLike ? content.toString("utf8") : undefined,
    };
  });
}

function normalizeCategory(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/^category[_-]/, "").replace(/^label[_-]/, "");
}

/**
 * Splits at the first reply marker line. `latest` is the original text before
 * the marker; deriving it from the trimmed quote's length left a stray
 * character whenever the quote ended in whitespace.
 */
function splitQuoted(text: string): { latest: string; quoted: string } {
  const lines = text.split(/\r?\n/);
  const marker = lines.findIndex((line) =>
    /^(?:On .+ wrote:|>{1,}|[- ]*Original Message[- ]*$)/iu.test(line.trim()),
  );
  if (marker < 0) return { latest: text.trim(), quoted: "" };
  let offset = 0;
  for (let index = 0; index < marker; index += 1) {
    offset += lines[index].length;
    offset += text.startsWith("\r\n", offset) ? 2 : 1;
  }
  return { latest: text.slice(0, offset).trim(), quoted: lines.slice(marker).join("\n").trim() };
}
