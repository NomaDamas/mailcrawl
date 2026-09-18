import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import type { MailMessage } from "./types.js";
import { redactDiagnostic } from "./redact.js";

const execFileAsync = promisify(execFile);

/** Default number of simultaneous `himalaya message read` processes. */
export const DEFAULT_READ_CONCURRENCY = 4;

/** Executes one himalaya invocation; replaced by tests. */
export type HimalayaExec = (args: string[], maxBuffer: number) => Promise<{ stdout: string; stderr?: string }>;

export interface HimalayaReadOptions {
  /** Simultaneous message reads; defaults to DEFAULT_READ_CONCURRENCY. */
  concurrency?: number;
  exec?: HimalayaExec;
}

export interface MailSource {
  list(): Promise<MailMessage[]>;
}

export class FixtureSource implements MailSource {
  constructor(private readonly path: string) {}

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

  async list(): Promise<MailMessage[]> {
    const envelopes = await this.envelopes();
    return mapWithConcurrency(envelopes, this.concurrency, async (envelope) => {
      const providerKey = envelopeKey(envelope);
      return envelopeMessage(this.account, this.mailbox, envelope, providerKey, await this.read(providerKey));
    });
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
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: width }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

function envelopeKey(envelope: HimalayaEnvelope): string {
  return String(envelope.id ?? envelope.uid ?? envelope["message-id"]);
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
    throw new Error(`himalaya ${operation} failed: ${redactDiagnostic(detail)}`);
  }
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
