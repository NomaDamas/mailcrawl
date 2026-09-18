import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import type { MailMessage, SourceReadFailure, SourceReadResult } from "./types.js";
import { redactDiagnostic } from "./redact.js";

const execFileAsync = promisify(execFile);

/** Default number of simultaneous `himalaya message read` processes. */
export const DEFAULT_READ_CONCURRENCY = 4;

/** Default number of attempts per message read, including the first one. */
export const DEFAULT_RETRY_ATTEMPTS = 3;

/** Default backoff before the second read attempt; doubles per round. */
export const DEFAULT_RETRY_BASE_DELAY_MS = 250;

/** Executes one himalaya invocation; replaced by tests. */
export type HimalayaExec = (args: string[], maxBuffer: number) => Promise<{ stdout: string; stderr?: string }>;

export interface HimalayaReadOptions {
  /** Simultaneous message reads; defaults to DEFAULT_READ_CONCURRENCY. */
  concurrency?: number;
  /** Attempts per message read, including the first one; defaults to DEFAULT_RETRY_ATTEMPTS. */
  retryAttempts?: number;
  /** Backoff before the second attempt, doubling per round; defaults to DEFAULT_RETRY_BASE_DELAY_MS. */
  retryBaseDelayMs?: number;
  exec?: HimalayaExec;
}

export interface MailSource {
  /** Messages that could be read, plus one record per message that could not. */
  collect(): Promise<SourceReadResult>;
  /** Strict variant of `collect()`: rejects when any message could not be read. */
  list(): Promise<MailMessage[]>;
}

export class FixtureSource implements MailSource {
  constructor(private readonly path: string) {}

  async collect(): Promise<SourceReadResult> {
    return { messages: await this.list(), failures: [] };
  }

  async list(): Promise<MailMessage[]> {
    const raw = await readFile(this.path, "utf8");
    return JSON.parse(raw) as MailMessage[];
  }
}

export class HimalayaSource implements MailSource {
  constructor(
    private readonly account: string,
    private readonly mailbox = "INBOX",
    private readonly backend?: string,
    private readonly pageSize = 1000,
    private readonly config?: string,
    private readonly readOptions: HimalayaReadOptions = {},
  ) {}

  async collect(): Promise<SourceReadResult> {
    return this.readPage(await this.envelopes());
  }

  async list(): Promise<MailMessage[]> {
    const { messages, failures } = await this.collect();
    if (failures.length > 0) throw new Error(failures[0].error);
    return messages;
  }

  /** Reads a page through a bounded pool, retrying failed reads in later rounds. */
  private async readPage(envelopes: HimalayaEnvelope[]): Promise<SourceReadResult> {
    const keys = envelopes.map(envelopeKey);
    const rawMime = new Map<number, string>();
    const errors = new Map<number, Error>();
    const attempts = Math.max(1, Math.floor(this.readOptions.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS));
    const baseDelayMs = Math.max(0, this.readOptions.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
    let pending = envelopes.map((_, index) => index);
    for (let attempt = 1; attempt <= attempts && pending.length > 0; attempt += 1) {
      if (attempt > 1) await delay(baseDelayMs * 2 ** (attempt - 2));
      const failed: number[] = [];
      await mapWithConcurrency(pending, this.concurrency, async (index) => {
        try {
          rawMime.set(index, await this.read(keys[index]));
        } catch (error) {
          errors.set(index, error instanceof Error ? error : new Error(String(error)));
          failed.push(index);
        }
      });
      pending = failed;
    }
    const messages: MailMessage[] = [];
    const failures: SourceReadFailure[] = [];
    envelopes.forEach((envelope, index) => {
      const raw = rawMime.get(index);
      if (raw !== undefined) {
        messages.push(envelopeMessage(this.account, this.mailbox, envelope, keys[index], raw));
        return;
      }
      failures.push({ providerKey: keys[index], attempts, error: (errors.get(index) ?? new Error("message read failed")).message });
    });
    return { messages, failures };
  }

  private get concurrency(): number {
    return Math.max(1, Math.floor(this.readOptions.concurrency ?? DEFAULT_READ_CONCURRENCY));
  }

  private async envelopes(): Promise<HimalayaEnvelope[]> {
    const args = this.baseArgs();
    args.push("envelope", "list", "--mailbox", this.mailbox, "--page-size", String(this.pageSize), "--json");
    const { stdout } = await this.run(args, 16 * 1024 * 1024, "envelope list");
    const payload = JSON.parse(stdout) as { envelopes?: HimalayaEnvelope[] };
    return payload.envelopes ?? (Array.isArray(payload) ? payload as unknown as HimalayaEnvelope[] : []);
  }

  private baseArgs(): string[] {
    const args = this.config ? ["-c", this.config, "-a", this.account] : ["-a", this.account];
    if (this.backend) args.push("-b", this.backend);
    return args;
  }

  private async read(id: string): Promise<string> {
    const args = this.baseArgs();
    args.push("--json", "message", "read", id, "--raw");
    const { stdout } = await this.run(args, 32 * 1024 * 1024, "message read");
    const payload = JSON.parse(stdout) as { message?: string };
    return payload.message ?? stdout;
  }

  private run(args: string[], maxBuffer: number, operation: string): Promise<{ stdout: string }> {
    return runHimalaya(args, maxBuffer, operation, this.readOptions.exec);
  }
}

/** Runs `worker` over `items` with at most `limit` workers in flight, preserving input order. */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let stopped = false;
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: width }, async () => {
    while (!stopped) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        // A failed page must not keep spawning provider processes for the
        // items that were never read; only the in-flight workers finish.
        stopped = true;
        throw error;
      }
    }
  }));
  return results;
}

function envelopeKey(envelope: HimalayaEnvelope): string {
  return String(envelope.id ?? envelope.uid ?? envelope["message-id"]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envelopeMessage(account: string, mailbox: string, envelope: HimalayaEnvelope, providerKey: string, rawMime: string): MailMessage {
  return {
    accountId: account,
    mailbox,
    providerKey,
    messageId: envelope["message-id"],
    inReplyTo: envelope["in-reply-to"]?.[0],
    subject: envelope.subject ?? "",
    from: address(envelope.from),
    to: addresses(envelope.to),
    cc: addresses(envelope.cc),
    date: envelope.date ?? new Date(0).toISOString(),
    text: envelope.body ?? envelope.snippet ?? "",
    labels: strings(envelope.labels),
    flags: strings(envelope.flags),
    classifications: strings(envelope.classifications),
    rawMime,
  };
}

async function runHimalaya(args: string[], maxBuffer: number, operation: string, exec?: HimalayaExec): Promise<{ stdout: string }> {
  try {
    return await (exec ?? defaultExec)(args, maxBuffer);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`himalaya ${operation} failed: ${redactDiagnostic(detail)}${stderrDetail(error)}`);
  }
}

/** Keeps himalaya's own stderr in the surfaced error so throttling is distinguishable from a malformed message. */
function stderrDetail(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null | undefined)?.stderr;
  if (typeof stderr !== "string") return "";
  const text = stderr.trim();
  if (!text) return "";
  return `: ${String(redactDiagnostic(text.length > 2_000 ? `${text.slice(0, 2_000)} [truncated]` : text))}`;
}

const defaultExec: HimalayaExec = (args, maxBuffer) => execFileAsync("himalaya", args, { maxBuffer });

interface HimalayaEnvelope {
  id?: string | number;
  uid?: string | number;
  "message-id"?: string;
  "in-reply-to"?: string[];
  subject?: string;
  from?: unknown;
  to?: unknown;
  cc?: unknown;
  date?: string;
  body?: string;
  snippet?: string;
  labels?: unknown;
  flags?: unknown;
  classifications?: unknown;
}

function address(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.length ? address(value[0]) : "";
  if (value && typeof value === "object" && "email" in value) return String(value.email);
  return "";
}

function addresses(value: unknown): string[] {
  if (!Array.isArray(value)) return value ? [address(value)] : [];
  return value.map(address).filter(Boolean);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}
