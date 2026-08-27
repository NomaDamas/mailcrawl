import type { LexicalLanguage } from "./types.js";

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

export function tokenizeForLanguage(language: LexicalLanguage, text: string): string {
  if (language === "ko") return tokenizeKorean(text);
  if (language === "ja") return tokenizeCjk(text);
  if (language === "zh") return tokenizeCjk(text);
  return tokenizeArabic(text);
}

function tokenizeKorean(text: string): string {
  const words = text.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.flatMap((word) => [word, ...jamoLikeSyllableTerms(word)]).join(" ");
}

function jamoLikeSyllableTerms(word: string): string[] {
  if (![...word].some((char) => /[\uac00-\ud7a3]/u.test(char))) return [];
  return [...word].length > 1 ? [...word].map((_, index) => [...word].slice(index, index + 2).join("")) : [];
}

function tokenizeCjk(text: string): string {
  const terms = text.normalize("NFKC").match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{L}\p{N}]+/gu) ?? [];
  return terms.flatMap((term) => [...term].length > 1
    ? [term, ...[...term].map((_, index) => [...term].slice(index, index + 2).join(""))]
    : [term]).join(" ");
}

function tokenizeArabic(text: string): string {
  return (text.normalize("NFKC").toLocaleLowerCase().match(/\p{Script=Arabic}+/gu) ?? [])
    .flatMap((word) => [word, word.replace(/^(?:وال|فال|بال|كال|ال|لل|و|ف|ب|ك|ل)/u, "")])
    .filter(Boolean).join(" ");
}
