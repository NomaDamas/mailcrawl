import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { FilesSnapshot, MailMessage, SourceFileSnapshot, SourceFileState, SourceReadFailure, SourceReadResult, UnlistedPath } from "./types.js";
import type { MailSource } from "./source.js";
import { parsedAttachments } from "./normalize.js";
import { makeId } from "./util.js";

/** Messages (one `.eml` file, or one entry of an mbox) larger than this are reported and skipped. */
export const MAX_MESSAGE_BYTES = 50 * 1024 * 1024;

/** Body text beyond this many characters is truncated before indexing. */
export const MAX_BODY_CHARS = 1_000_000;

const MAIL_KIND_BY_EXTENSION: Record<string, "eml" | "mbox"> = { ".eml": "eml", ".mbox": "mbox", ".mbx": "mbox" };

/**
 * `.eml` → eml; `.mbox`/`.mbx` → mbox; and the extensionless `mbox` file inside
 * an Apple Mail export bundle (`Inbox.mbox/mbox`) → mbox.
 */
function mailKind(path: string): "eml" | "mbox" | undefined {
  const extension = extname(path).toLowerCase();
  if (Object.hasOwn(MAIL_KIND_BY_EXTENSION, extension)) return MAIL_KIND_BY_EXTENSION[extension];
  return basename(path) === "mbox" && extname(dirname(path)).toLowerCase() === ".mbox" ? "mbox" : undefined;
}

export interface FilesReadResult extends SourceReadResult {
  snapshot: FilesSnapshot;
  /** Path-opaque labels of messages skipped because an earlier file in this sync supplied the same provider key. */
  duplicates: string[];
}

export interface FilesSourceOptions {
  paths: string[];
  account?: string;
  /** Overrides the per-file mailbox (mbox file stem, or the directory holding an `.eml`). */
  mailbox?: string;
  /** Stored state for files under a root, keyed by root-relative path; unchanged files are not re-read. */
  previous?: (rootKey: string) => Map<string, SourceFileState>;
}

/**
 * Reads `.eml` files and `.mbox`/`.mbx` archives (including Apple Mail
 * `X.mbox/mbox` bundles) from disk.
 *
 * Provider identity is the `Message-ID` header, or the SHA-256 of the raw
 * message bytes when the header is missing, so a re-sync of unchanged mail is
 * a no-op and an mbox append adds exactly the appended message. Diagnostics
 * name files relative to the `--path` root (`<root name>/<relative path>`),
 * never by absolute path.
 */
export class FilesSource implements MailSource {
  readonly account: string;

  constructor(private readonly options: FilesSourceOptions) {
    if (!options.paths.length) throw new Error("--path is required for files source");
    const first = resolve(options.paths[0]);
    this.account = options.account ?? (basename(first, extname(first)) || "files");
  }

  async collect(): Promise<FilesReadResult> {
    const messages: MailMessage[] = [];
    const failures: SourceReadFailure[] = [];
    const duplicates: string[] = [];
    const files: SourceFileSnapshot[] = [];
    const rootKeys: string[] = [];
    const unlisted: UnlistedPath[] = [];
    const seen = new Set<string>();
    for (const input of this.options.paths) {
      const root = await resolveRoot(input);
      // The mailbox override is part of the root identity: re-running with a
      // different --mailbox must re-read files instead of trusting stale state.
      const rootKey = makeId(this.account, this.options.mailbox ?? "", root.path);
      rootKeys.push(rootKey);
      const previous = this.options.previous?.(rootKey) ?? new Map<string, SourceFileState>();
      const listing = await listMailFiles(root);
      for (const failure of listing.failures) {
        unlisted.push({ rootKey, relPath: failure.relPath });
        failures.push({ providerKey: failure.label, attempts: 1, error: failure.error });
      }
      for (const file of listing.files) {
        const stored = previous.get(file.relPath);
        const changed = !stored || stored.size !== file.size || stored.mtimeMs !== file.mtimeMs;
        const snapshot: SourceFileSnapshot = {
          rootKey, relPath: file.relPath, size: file.size, mtimeMs: file.mtimeMs,
          changed, status: "complete", messages: [],
          failures: changed ? [] : stored.failures, failedEntries: changed ? [] : stored.failedEntries,
        };
        const knownFailures = new Set(stored?.failedEntries ?? []);
        files.push(snapshot);
        if (!changed) {
          failures.push(...stored.failures);
          continue;
        }
        // mbox: file stem, or the bundle stem for Apple Mail `Inbox.mbox/mbox`; eml: holding directory.
        const mboxPath = basename(file.path) === "mbox" ? dirname(file.path) : file.path;
        const mailbox = this.options.mailbox
          ?? (file.kind === "eml" ? basename(dirname(file.path)) : basename(mboxPath, extname(mboxPath)) || "files");
        const accept = (entry: ReadEntry): void => {
          if ("error" in entry) {
            // A malformed .eml holds no other message, so its previous message is
            // released. A newly failing mbox entry may be a previously indexed
            // message, so that read removes nothing; an entry that failed last
            // time with the same bytes keeps the read authoritative.
            if (entry.unreadable) snapshot.status = "unreadable";
            else if (entry.entryKey && !knownFailures.has(entry.entryKey) && snapshot.status === "complete") snapshot.status = "partial";
            if (entry.entryKey) snapshot.failedEntries.push(entry.entryKey);
            const failure = { providerKey: entry.label, attempts: 1, error: entry.error };
            snapshot.failures.push(failure);
            failures.push(failure);
            return;
          }
          // Every file that holds a message is attributed, duplicates included,
          // so the message survives until the last file holding it disappears.
          snapshot.messages.push({ mailbox, providerKey: entry.message.providerKey });
          const scoped = `${mailbox}\0${entry.message.providerKey}`;
          if (seen.has(scoped)) {
            duplicates.push(entry.label);
            return;
          }
          seen.add(scoped);
          messages.push({ ...entry.message, accountId: this.account, mailbox });
        };
        if (file.kind === "eml") await readEml(file, accept);
        else await readMbox(file, accept);
      }
    }
    return { messages, failures, duplicates, snapshot: { accountId: this.account, rootKeys, files, unlisted } };
  }

  async list(): Promise<MailMessage[]> {
    const { messages, failures } = await this.collect();
    if (failures.length > 0) throw new Error(failures[0].error);
    return messages;
  }
}

interface MailFile {
  path: string;
  relPath: string;
  /** `<root name>/<relative path>`: the only file name that appears in diagnostics. */
  label: string;
  kind: "eml" | "mbox";
  size: number;
  mtimeMs: number;
}

type ParsedEntry = Omit<MailMessage, "accountId" | "mailbox">;
/** `entryKey` identifies a failed mbox entry by content, so the same broken entry is recognized on the next read. */
type ReadEntry = { label: string; message: ParsedEntry } | { label: string; error: string; unreadable?: boolean; entryKey?: string };

async function resolveRoot(input: string): Promise<{ path: string; name: string; isFile: boolean }> {
  const name = basename(resolve(input));
  try {
    const path = await realpath(input);
    return { path, name, isFile: (await stat(path)).isFile() };
  } catch (error) {
    throw new Error(`--path ${name} cannot be read (${errorCode(error)})`);
  }
}

interface ListingFailure {
  relPath: string;
  label: string;
  error: string;
}

/** Lists mail files under a root. A directory or file that cannot be listed or stat'ed is reported, never fatal. */
async function listMailFiles(root: { path: string; name: string; isFile: boolean }): Promise<{ files: MailFile[]; failures: ListingFailure[] }> {
  const failures: ListingFailure[] = [];
  const relOf = (path: string): string => root.isFile ? basename(path) : relative(root.path, path).split(sep).join("/");
  const labelOf = (relPath: string): string => root.isFile ? relPath : relPath ? `${root.name}/${relPath}` : root.name;
  const fail = (path: string, what: string, error: unknown): void => {
    const relPath = relOf(path);
    failures.push({ relPath, label: labelOf(relPath), error: `${what} cannot be read (${errorCode(error)})` });
  };
  const paths = root.isFile ? [root.path] : await walk(root.path, (path, error) => fail(path, "directory", error));
  const files: MailFile[] = [];
  for (const path of paths) {
    const kind = mailKind(path);
    if (!kind) continue;
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      fail(path, "file", error);
      continue;
    }
    const relPath = relOf(path);
    files.push({ path, relPath, label: labelOf(relPath), kind, size: info.size, mtimeMs: info.mtimeMs });
  }
  return { files, failures };
}

/** Recursively lists regular files (following file symlinks, never directory symlinks), sorted for deterministic duplicate resolution. */
async function walk(directory: string, onError: (path: string, error: unknown) => void): Promise<string[]> {
  let entries;
  try {
    entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    onError(directory, error);
    return [];
  }
  const output: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path, onError));
    else if (entry.isFile()) output.push(path);
    else if (entry.isSymbolicLink() && mailKind(path) && (await stat(path).catch(() => undefined))?.isFile()) output.push(path);
  }
  return output;
}

async function readEml(file: MailFile, accept: (entry: ReadEntry) => void): Promise<void> {
  if (file.size > MAX_MESSAGE_BYTES) {
    accept({ label: file.label, error: `message exceeds ${MAX_MESSAGE_BYTES} bytes` });
    return;
  }
  let raw: Buffer;
  try {
    raw = await readFile(file.path);
  } catch (error) {
    accept({ label: file.label, error: `file cannot be read (${errorCode(error)})`, unreadable: true });
    return;
  }
  accept(await parseEntry(file.label, raw));
}

/**
 * Streams an mbox (mboxo or mboxrd). A message starts at a `From ` line at the
 * start of the file or after a blank line; `>From ` quoting is undone by one
 * level (mboxrd), which is also correct for mboxo's single-level escaping.
 */
async function readMbox(file: MailFile, accept: (entry: ReadEntry) => void): Promise<void> {
  let ordinal = 0;
  let current: { lines: Buffer[]; bytes: number; envelope: string; oversize: boolean } | undefined;
  let previousBlank = true;
  let notMbox = false;

  const finish = async (): Promise<void> => {
    if (!current) return;
    const label = `${file.label}#${ordinal}`;
    const message = current;
    current = undefined;
    if (message.oversize) {
      accept({ label, error: `message exceeds ${MAX_MESSAGE_BYTES} bytes`, entryKey: `oversize:${message.envelope}` });
      return;
    }
    let raw = Buffer.concat(message.lines, message.bytes);
    // The blank line before the next separator belongs to the mbox framing.
    if (raw.subarray(-4).equals(CRLF_CRLF)) raw = raw.subarray(0, -2);
    else if (raw.subarray(-2).equals(LF_LF)) raw = raw.subarray(0, -1);
    const entry = await parseEntry(label, raw, envelopeDate(message.envelope));
    accept("error" in entry ? { ...entry, entryKey: `sha256:${createHash("sha256").update(raw).digest("hex")}` } : entry);
  };

  const onLine = async (line: Buffer): Promise<void> => {
    // An editor-added UTF-8 BOM before the first separator is not content.
    if (ordinal === 0 && !current && line.subarray(0, 3).equals(UTF8_BOM)) line = line.subarray(3);
    const isSeparator = previousBlank && line.subarray(0, 5).equals(FROM_PREFIX);
    previousBlank = line.length === 1 ? line[0] === LF : line.length === 2 && line[0] === CR && line[1] === LF;
    if (isSeparator) {
      await finish();
      ordinal += 1;
      current = { lines: [], bytes: 0, envelope: line.toString("latin1").trim(), oversize: false };
      return;
    }
    if (!current) {
      if (!previousBlank) notMbox = true;
      return;
    }
    if (current.oversize) return;
    const content = isEscapedFrom(line) ? line.subarray(1) : line;
    current.bytes += content.length;
    if (current.bytes > MAX_MESSAGE_BYTES) {
      current.oversize = true;
      current.lines = [];
      return;
    }
    current.lines.push(content);
  };

  try {
    let carry: Buffer | undefined;
    for await (const chunk of createReadStream(file.path, { highWaterMark: 1024 * 1024 }) as AsyncIterable<Buffer>) {
      const buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
      let start = 0;
      for (let index = buffer.indexOf(LF, start); index !== -1; index = buffer.indexOf(LF, start)) {
        await onLine(buffer.subarray(start, index + 1));
        if (notMbox) break;
        start = index + 1;
      }
      if (notMbox) break;
      carry = start < buffer.length ? Buffer.from(buffer.subarray(start)) : undefined;
      if (carry && carry.length > MAX_MESSAGE_BYTES) {
        // A single line longer than the message cap: count it toward the current message without buffering it.
        if (current) {
          current.oversize = true;
          current.lines = [];
        }
        carry = undefined;
        previousBlank = false;
      }
    }
    if (!notMbox && carry) await onLine(carry);
  } catch (error) {
    accept({ label: file.label, error: `file cannot be read (${errorCode(error)})`, unreadable: true });
    return;
  }
  if (notMbox) {
    // Unreadable, not complete: an indexed mbox whose head gained stray bytes
    // must keep its messages instead of releasing all of them.
    accept({ label: file.label, error: "not an mbox file: content before the first From_ separator", unreadable: true });
    return;
  }
  await finish();
}

async function parseEntry(label: string, raw: Buffer, fallbackDate?: string): Promise<ReadEntry> {
  let parsed: ParsedMail;
  try {
    parsed = await simpleParser(raw);
  } catch (error) {
    return { label, error: `message cannot be parsed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!parsed.headers || parsed.headers.size === 0) return { label, error: "message has no parseable headers" };
  const header = parsed.messageId?.trim();
  // `Message-ID: <>` is not an identity; distinct messages carrying it must not collapse into one.
  const messageId = header && header !== "<>" ? header : undefined;
  return {
    label,
    message: {
      providerKey: messageId ? `message-id:${messageId}` : `sha256:${createHash("sha256").update(raw).digest("hex")}`,
      messageId,
      inReplyTo: parsed.inReplyTo?.trim().split(/\s+/)[0] || undefined,
      subject: parsed.subject ?? "",
      from: parsed.from?.value[0]?.address ?? "",
      to: addresses(parsed.to),
      cc: addresses(parsed.cc),
      date: headerDate(parsed) ?? fallbackDate ?? new Date(0).toISOString(),
      text: (parsed.text ?? "").slice(0, MAX_BODY_CHARS),
      attachments: parsedAttachments(parsed),
      labels: gmailLabels(parsed.headers.get("x-gmail-labels")),
    },
  };
}

/** mailparser replaces an unparseable Date header with the parse time; read the raw header instead so identity data stays stable. */
function headerDate(parsed: ParsedMail): string | undefined {
  const line = parsed.headerLines?.find((entry) => entry.key === "date")?.line;
  if (!line) return undefined;
  const date = new Date(line.slice(line.indexOf(":") + 1).trim());
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * `From sender@example.com Mon Jan  1 00:00:00 2024` → ISO date. The From_
 * line carries an asctime date in UTC; without an explicit zone it must not be
 * read in the host's local time zone.
 */
function envelopeDate(envelope: string): string | undefined {
  const rest = envelope.split(/\s+/).slice(2).join(" ");
  if (!rest) return undefined;
  const date = new Date(/(?:[+-]\d{4}|\b(?:UTC|GMT))\b/.test(rest) ? rest : `${rest} UTC`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function addresses(value: AddressObject | AddressObject[] | undefined): string[] {
  const objects = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return objects.flatMap((object) => object.value.flatMap((entry) => entry.group ? entry.group.map((member) => member.address ?? "") : [entry.address ?? ""]))
    .filter(Boolean);
}

/**
 * Gmail Takeout writes `X-Gmail-Labels: Inbox,Category Promotions,"a, b"`.
 * Category labels are mapped to the Gmail API form (`CATEGORY_PROMOTIONS`) so
 * the default spam/promotions exclusion applies as it does for live Gmail.
 */
function gmailLabels(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  const labels = [...value.matchAll(/"((?:[^"\\]|\\.)*)"|([^,]+)/g)]
    .map((match) => (match[1] ?? match[2]).trim())
    .filter(Boolean);
  return labels.map((label) => /^category /i.test(label) ? `CATEGORY_${label.slice(9).trim().toUpperCase()}` : label);
}

function isEscapedFrom(line: Buffer): boolean {
  let index = 0;
  while (line[index] === GT) index += 1;
  return index > 0 && line.subarray(index, index + 5).equals(FROM_PREFIX);
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "error";
}

const LF = 0x0a;
const CR = 0x0d;
const GT = 0x3e;
const FROM_PREFIX = Buffer.from("From ");
const LF_LF = Buffer.from("\n\n");
const CRLF_CRLF = Buffer.from("\r\n\r\n");
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
