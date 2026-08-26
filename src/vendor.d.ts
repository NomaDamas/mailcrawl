declare module "mailparser" {
  export interface ParsedMail {
    text?: string;
    html?: string | false;
  }

  export function simpleParser(source: string): Promise<ParsedMail>;
}
