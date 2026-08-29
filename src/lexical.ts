import { KiwiBuilder, Match, type Kiwi } from "kiwi-nlp";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import type { LexicalLanguage } from "./types.js";

export const LEXICAL_ANALYZER_VERSION = "kiwi-nlp@0.23.x+kagome-ipa-search+gse-search+arabic-light-v1";

export function lexicalFields(): LexicalLanguage[] {
  return ["ko", "ja", "zh", "ar"];
}

export function languagesForText(text: string): LexicalLanguage[] {
  const languages: LexicalLanguage[] = [];
  if (/[\uac00-\ud7a3]/u.test(text)) languages.push("ko");
  if (/[\u3040-\u30ff]/u.test(text)) languages.push("ja");
  if (/[\u4e00-\u9fff]/u.test(text)) languages.push("zh");
  if (/[\u0600-\u06ff]/u.test(text)) languages.push("ar");
  return languages;
}

export interface LexicalAnalyzers {
  tokenize(language: LexicalLanguage, text: string): Promise<string>;
  close(): Promise<void>;
}

export async function createLexicalAnalyzers(required: LexicalLanguage[] = lexicalFields()): Promise<LexicalAnalyzers> {
  if (process.env.NODE_ENV === "test" || process.env.MAILCRAWL_LEXICAL_MODE === "mock") {
    return { tokenize: async (language, text) => tokenizeMock(language, text), close: async () => undefined };
  }
  return new ConfiguredAnalyzers(
    required.includes("ko") ? await KiwiAnalyzer.create() : undefined,
    required.includes("ja") ? await HelperAnalyzer.create("ja", process.env.MAILCRAWL_JA_HELPER, "mailcrawl-ja") : undefined,
    required.includes("zh") ? await HelperAnalyzer.create("zh", process.env.MAILCRAWL_ZH_HELPER, "mailcrawl-zh") : undefined,
  );
}

class ConfiguredAnalyzers implements LexicalAnalyzers {
  constructor(
    private readonly korean?: KiwiAnalyzer,
    private readonly japanese?: HelperAnalyzer,
    private readonly chinese?: HelperAnalyzer,
  ) {}

  tokenize(language: LexicalLanguage, text: string): Promise<string> {
    if (language === "ko" && this.korean) return this.korean.tokenize(text);
    if (language === "ja" && this.japanese) return this.japanese.tokenize(text);
    if (language === "zh" && this.chinese) return this.chinese.tokenize(text);
    return Promise.resolve(tokenizeArabic(text));
  }

  async close(): Promise<void> {
    await Promise.all([this.korean?.close(), this.japanese?.close(), this.chinese?.close()]);
  }
}

class KiwiAnalyzer {
  private constructor(private readonly kiwi: Kiwi) {}

  static async create(): Promise<KiwiAnalyzer> {
    const wasmPath = process.env.MAILCRAWL_KIWI_WASM
      ?? createRequire(import.meta.url).resolve("kiwi-nlp/dist/kiwi-wasm.wasm");
    const modelDir = process.env.MAILCRAWL_KIWI_MODEL;
    if (!wasmPath || !modelDir) {
      throw new Error("Korean analyzer requires MAILCRAWL_KIWI_WASM and MAILCRAWL_KIWI_MODEL");
    }
    const builder = await KiwiBuilder.create(wasmPath);
    const modelFiles = Object.fromEntries(
      readdirSync(modelDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => [entry.name, readFileSync(`${modelDir}/${entry.name}`)]),
    );
    if (!Object.keys(modelFiles).length) throw new Error(`Korean Kiwi model directory is empty: ${modelDir}`);
    return new KiwiAnalyzer(await builder.build({ modelFiles, modelType: "cong", loadDefaultDict: true, loadTypoDict: true }));
  }

  async tokenize(text: string): Promise<string> {
    return this.kiwi.tokenize(text, Match.allWithNormalizing).map((token) => token.str).join(" ");
  }

  async close(): Promise<void> {}
}

class HelperAnalyzer {
  private constructor(
    private readonly language: LexicalLanguage,
    private readonly process: ChildProcessWithoutNullStreams,
    private readonly lines: Interface,
  ) {}

  static async create(language: "ja" | "zh", command: string | undefined, fallbackName: string): Promise<HelperAnalyzer> {
    const resolved = command || fallbackName;
    const process = spawn(resolved, [], { stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: process.stdout });
    const analyzer = new HelperAnalyzer(language, process, lines);
    const startup = await analyzer.readLine();
    const response = JSON.parse(startup) as { ready?: boolean; error?: string };
    if (response.error) throw new Error(`${fallbackName}: ${response.error}`);
    if (!response.ready) throw new Error(`${fallbackName} did not report ready`);
    return analyzer;
  }

  async tokenize(text: string): Promise<string> {
    return this.request(text);
  }

  async close(): Promise<void> {
    this.lines.close();
    this.process.kill();
  }

  private request(text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      const onLine = (line: string) => {
        try {
          const response = JSON.parse(line) as { ready?: boolean; tokens?: string; error?: string };
          this.lines.off("line", onLine);
          this.process.off("error", onError);
          if (response.error) reject(new Error(`${this.language} analyzer: ${response.error}`));
          else resolve(response.ready ? "ready" : response.tokens ?? "");
        } catch (error) {
          reject(error);
        }
      };
      this.lines.on("line", onLine);
      this.process.once("error", onError);
      this.process.stdin.write(`${JSON.stringify({ text })}\n`);
    });
  }

  private readLine(): Promise<string> {
    return new Promise((resolve, reject) => {
      const onLine = (line: string) => {
        this.lines.off("line", onLine);
        resolve(line);
      };
      this.lines.on("line", onLine);
      this.process.once("error", reject);
    });
  }
}

function tokenizeMock(language: LexicalLanguage, text: string): string {
  if (language === "ko") return text.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
  if (language === "ja" || language === "zh") return text.normalize("NFKC").match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{L}\p{N}]+/gu)?.join(" ") ?? "";
  return tokenizeArabic(text);
}

export function tokenizeForLanguage(language: LexicalLanguage, text: string): string {
  return tokenizeMock(language, text);
}

function tokenizeArabic(text: string): string {
  return (text.normalize("NFKC").toLocaleLowerCase().match(/\p{Script=Arabic}+/gu) ?? [])
    .flatMap((word) => [word, word.replace(/^(?:وال|فال|بال|كال|ال|لل|و|ف|ب|ك|ل)/u, "")])
    .filter(Boolean).join(" ");
}
