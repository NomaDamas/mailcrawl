import { createHash } from "node:crypto";

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeSubject(subject: string): string {
  return subject.replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/giu, "").trim().toLocaleLowerCase();
}

export function makeId(...parts: string[]): string {
  return hash(parts.join("\u0000")).slice(0, 24);
}

export function scopedId(accountId: string, mailbox: string, value: string): string {
  return makeId(accountId, mailbox, value);
}

export function snippet(text: string, query: string, maxChars = 240): string {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  const index = clean.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  const start = Math.max(0, index < 0 ? 0 : index - 60);
  return clean.slice(start, start + maxChars);
}
