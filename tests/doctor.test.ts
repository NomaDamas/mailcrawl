import { describe, expect, it } from "vitest";
import { redactDiagnostic } from "../src/redact.js";

describe("operational diagnostics", () => {
  it("redacts nested credentials and addresses", () => {
    const result = redactDiagnostic({ nested: { token: "abc", detail: "owner@example.com" } });
    expect(result).toEqual({ nested: { token: "[REDACTED]", detail: "[EMAIL]" } });
  });
});
