declare module "mailparser" {
  export interface ParsedMail {
    text?: string;
    html?: string | false;
    attachments?: Array<{
      filename?: string;
      contentType?: string;
      size?: number;
      content?: Buffer;
    }>;
  }

  export function simpleParser(source: string): Promise<ParsedMail>;
}
