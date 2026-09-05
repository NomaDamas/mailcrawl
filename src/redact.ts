export function redactDiagnostic(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/([?&](?:token|password|secret|key)=)[^&\s]+/giu, "$1[REDACTED]")
      .replace(/(?<![?&])\b(?:token|password|secret|key|credential)\s*[=:]\s*[^,\s]+/giu, "[REDACTED]")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[EMAIL]");
  }
  if (Array.isArray(value)) return value.map(redactDiagnostic);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key, /password|secret|token|credential/iu.test(key) ? "[REDACTED]" : redactDiagnostic(entry),
    ]));
  }
  return value;
}
