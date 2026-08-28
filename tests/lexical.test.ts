import { describe, expect, it } from "vitest";
import { languagesForText, tokenizeForLanguage } from "../src/lexical.js";

describe("multilingual lexical analysis", () => {
  it("selects analyzers from scripts", () => {
    expect(languagesForText("계약 갱신")).toEqual(["ko"]);
    expect(languagesForText("契約の更新")).toEqual(["ja", "zh"]);
    expect(languagesForText("والكتاب")).toEqual(["ar"]);
  });

  it("adds searchable subword terms for CJK and Arabic", () => {
    expect(tokenizeForLanguage("ko", "계약갱신조건")).toContain("계약갱신조건");
    expect(tokenizeForLanguage("ja", "契約更新")).toContain("契約");
    expect(tokenizeForLanguage("zh", "合同更新")).toContain("合同");
    expect(tokenizeForLanguage("ar", "والكتاب")).toContain("كتاب");
  });
});
