import { simpleParser } from "mailparser";
import type { MailMessage, NormalizedMessage } from "./types.js";
import { hash, makeId, normalizeSubject } from "./util.js";

export async function normalizeMessage(input: MailMessage): Promise<NormalizedMessage> {
  let text = input.text || "";
  let html = input.html;
  if (input.rawMime) {
    const parsed = await simpleParser(input.rawMime);
    text = parsed.text || "";
    html = typeof parsed.html === "string" ? parsed.html : undefined;
  }
  const quoted = extractQuoted(text);
  const latest = text.slice(0, text.length - quoted.length).trim();
  const subject = input.subject.trim();
  const messageId = input.messageId || input.providerKey;
  const threadId = input.threadId || makeId(input.accountId, normalizeSubject(subject));
  const normalizedHash = hash(JSON.stringify([subject, input.from, input.to, input.cc, latest, quoted]));
  return {
    ...input,
    messageId,
    threadId,
    html,
    normalizedSubject: normalizeSubject(subject),
    latestText: latest,
    quotedText: quoted,
    text: latest,
    normalizedHash,
  };
}

function extractQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const marker = lines.findIndex((line) =>
    /^(?:On .+ wrote:|>{1,}|[- ]*Original Message[- ]*$)/iu.test(line.trim()),
  );
  return marker < 0 ? "" : lines.slice(marker).join("\n").trim();
}
