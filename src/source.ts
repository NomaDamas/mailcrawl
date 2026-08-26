import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import type { MailMessage } from "./types.js";

const execFileAsync = promisify(execFile);

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
  ) {}

  async list(): Promise<MailMessage[]> {
    const args = ["-a", this.account];
    if (this.backend) args.push("-b", this.backend);
    args.push("envelope", "list", "--mailbox", this.mailbox, "--page-size", "1000", "--json");
    const { stdout } = await execFileAsync("himalaya", args, { maxBuffer: 16 * 1024 * 1024 });
    const payload = JSON.parse(stdout) as { envelopes?: HimalayaEnvelope[] };
    const envelopes = payload.envelopes ?? (Array.isArray(payload) ? payload as unknown as HimalayaEnvelope[] : []);
    return envelopes.map((envelope) => ({
      accountId: this.account,
      mailbox: this.mailbox,
      providerKey: String(envelope.id ?? envelope.uid ?? envelope.message_id),
      messageId: envelope.message_id,
      threadId: envelope.thread_id,
      subject: envelope.subject ?? "",
      from: address(envelope.from),
      to: addresses(envelope.to),
      cc: addresses(envelope.cc),
      date: envelope.date ?? new Date(0).toISOString(),
      text: envelope.body ?? envelope.snippet ?? "",
    }));
  }
}

interface HimalayaEnvelope {
  id?: string | number;
  uid?: string | number;
  message_id?: string;
  thread_id?: string;
  subject?: string;
  from?: unknown;
  to?: unknown;
  cc?: unknown;
  date?: string;
  body?: string;
  snippet?: string;
}

function address(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "email" in value) return String(value.email);
  return "";
}

function addresses(value: unknown): string[] {
  if (!Array.isArray(value)) return value ? [address(value)] : [];
  return value.map(address).filter(Boolean);
}
