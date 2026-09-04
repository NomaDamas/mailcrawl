import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type PackageManifest = {
  devDependencies?: Record<string, string>;
};

describe("issue 25: clean checkout build toolchain", () => {
  it("declares TypeScript as a local development dependency", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as PackageManifest;

    expect(manifest.devDependencies?.typescript).toBeTruthy();
  });
});
