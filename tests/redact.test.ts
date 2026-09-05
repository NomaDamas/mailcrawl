import { describe, expect, it } from "vitest";
import { redactDiagnostic } from "../src/redact.js";

describe("diagnostic redaction", () => {
  it("removes credentials and addresses from diagnostics", () => {
    expect(redactDiagnostic({ password: "secret", detail: "https://x.test?a=1&token=abc user@example.com" }))
      .toEqual({ password: "[REDACTED]", detail: "https://x.test?a=1&token=[REDACTED] [EMAIL]" });
  });

  it("redacts credentials embedded in child-process diagnostics", () => {
    expect(redactDiagnostic("password=SUPERSECRET token=abc123 owner@example.com"))
      .toBe("[REDACTED] [REDACTED] [EMAIL]");
  });
});
