declare module "mailparser" {
  export interface AddressObject {
    value: Array<{ address?: string; name?: string; group?: Array<{ address?: string; name?: string }> }>;
    text: string;
  }

  export interface ParsedMail {
    headers: Map<string, unknown>;
    subject?: string;
    /** Raw header lines in source order; mailparser leaves `key` empty for lines it cannot parse. */
    headerLines?: Array<{ key: string; line: string }>;
    from?: AddressObject;
    to?: AddressObject | AddressObject[];
    cc?: AddressObject | AddressObject[];
    date?: Date;
    messageId?: string;
    inReplyTo?: string;
    references?: string | string[];
    text?: string;
    html?: string | false;
    attachments?: Array<{
      filename?: string;
      contentType?: string;
      size?: number;
      content?: Buffer;
    }>;
  }

  export function simpleParser(source: string | Buffer): Promise<ParsedMail>;
}
