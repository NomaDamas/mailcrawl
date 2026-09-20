import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  KIWI_MODEL_FILES,
  KIWI_MODEL_URL,
  KiwiModelMissingError,
  KiwiWasmUnresolvedError,
  inspectKoreanAnalyzer,
  resolveKiwiModelDir,
  resolveKiwiWasmPath,
} from "../src/kiwi-runtime.js";

const run = promisify(execFile);
const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}

async function plantModel(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  for (const name of KIWI_MODEL_FILES) await writeFile(join(directory, name), name);
  return directory;
}

describe("issue 35: Korean Kiwi provisioning", () => {
  it("auto-provisions the Kiwi model into cache when MAILCRAWL_KIWI_MODEL is unset", async () => {
    // Given a clean cache and no MAILCRAWL_KIWI_MODEL
    const xdg = await tempDir("mailcrawl-kiwi-xdg-");
    const fetched: string[] = [];
    const env = { XDG_CACHE_HOME: xdg, HOME: xdg };

    // When the model directory is resolved
    const modelDir = await resolveKiwiModelDir({
      env,
      fetchTarball: async (url) => {
        fetched.push(url);
        return Buffer.from("fake-tarball");
      },
      extractTarball: async (_archive, dest) => {
        await plantModel(join(dest, "cong", "base"));
      },
    });

    // Then the official tarball is fetched once and cong.mdl is present
    expect(fetched).toEqual([KIWI_MODEL_URL]);
    expect(existsSync(join(modelDir, "cong.mdl"))).toBe(true);
  });

  it("reuses a complete cache without refetching", async () => {
    // Given a cache that already contains the Kiwi model files
    const xdg = await tempDir("mailcrawl-kiwi-cache-");
    const cached = await plantModel(join(xdg, "mailcrawl", "kiwi-model", "0.23.0", "cong", "base"));
    const fetched: string[] = [];

    // When resolveKiwiModelDir runs again
    const modelDir = await resolveKiwiModelDir({
      env: { XDG_CACHE_HOME: xdg, HOME: xdg },
      fetchTarball: async (url) => {
        fetched.push(url);
        return Buffer.from("should-not-run");
      },
    });

    // Then the cached directory is returned and nothing is downloaded
    expect(modelDir).toBe(cached);
    expect(fetched).toEqual([]);
  });

  it("uses MAILCRAWL_KIWI_MODEL as an override without downloading", async () => {
    // Given both a populated override directory and a populated cache
    const xdg = await tempDir("mailcrawl-kiwi-override-");
    await plantModel(join(xdg, "mailcrawl", "kiwi-model", "0.23.0", "cong", "base"));
    const override = await plantModel(join(xdg, "override-model"));
    const fetched: string[] = [];

    // When MAILCRAWL_KIWI_MODEL is set
    const modelDir = await resolveKiwiModelDir({
      env: { XDG_CACHE_HOME: xdg, HOME: xdg, MAILCRAWL_KIWI_MODEL: override },
      fetchTarball: async (url) => {
        fetched.push(url);
        return Buffer.from("should-not-run");
      },
    });

    // Then the override path wins and fetch is not called
    expect(modelDir).toBe(override);
    expect(fetched).toEqual([]);
  });

  it("names only MAILCRAWL_KIWI_MODEL when the override directory is empty", async () => {
    // Given an empty MAILCRAWL_KIWI_MODEL directory
    const empty = await tempDir("mailcrawl-kiwi-empty-");

    // When resolveKiwiModelDir reads that override
    const error = await resolveKiwiModelDir({ env: { MAILCRAWL_KIWI_MODEL: empty } }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    // Then the error names the model variable and not WASM
    expect(error).toBeInstanceOf(KiwiModelMissingError);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("MAILCRAWL_KIWI_MODEL");
    expect(message).not.toContain("MAILCRAWL_KIWI_WASM");
    expect(message).toContain(empty);
  });

  it("resolves the packaged kiwi-nlp WASM without MAILCRAWL_KIWI_WASM", () => {
    // Given no WASM override
    // When the default resolver runs
    const wasmPath = resolveKiwiWasmPath({ env: {} });

    // Then the packaged kiwi-wasm.wasm file is found
    expect(existsSync(wasmPath)).toBe(true);
    expect(wasmPath.endsWith("kiwi-wasm.wasm")).toBe(true);
  });

  it("resolves WASM from a relocated argv1 package tree", async () => {
    // Given kiwi-nlp is only reachable from the real package root, not import.meta.url
    const root = await tempDir("mailcrawl-kiwi-pkg-");
    const relocated = await tempDir("mailcrawl-kiwi-relocated-");
    const wasm = join(root, "node_modules", "kiwi-nlp", "dist", "kiwi-wasm.wasm");
    await mkdir(dirname(wasm), { recursive: true });
    await writeFile(wasm, "wasm");
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@nomadamas/mailcrawl" }));
    const argv1 = join(root, "dist", "cli", "index.js");
    await mkdir(dirname(argv1), { recursive: true });
    await writeFile(argv1, "#!/usr/bin/env node\n");
    const copied = join(relocated, "copied.js");
    await writeFile(copied, "export {}\n");

    // When resolution starts from the relocated copy
    const resolved = resolveKiwiWasmPath({
      env: {},
      fromModuleUrl: pathToFileURL(copied).href,
      argv1,
    });

    // Then the WASM file next to the real package is used
    expect(resolved).toBe(realpathSync(wasm));
  });

  it("names only MAILCRAWL_KIWI_WASM when the engine cannot be resolved", async () => {
    // Given a module location with no kiwi-nlp and no argv fallback
    const isolated = await tempDir("mailcrawl-kiwi-nowasm-");
    const modulePath = join(isolated, "orphan.js");
    await writeFile(modulePath, "export {}\n");

    // When WASM resolution runs
    expect(() => resolveKiwiWasmPath({
      env: {},
      fromModuleUrl: pathToFileURL(modulePath).href,
      argv1: join(isolated, "missing-bin"),
    })).toThrow(KiwiWasmUnresolvedError);

    try {
      resolveKiwiWasmPath({
        env: {},
        fromModuleUrl: pathToFileURL(modulePath).href,
        argv1: join(isolated, "missing-bin"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("MAILCRAWL_KIWI_WASM");
      expect(message).not.toContain("MAILCRAWL_KIWI_MODEL");
    }
  });

  it("reports ready from a complete cache without MAILCRAWL_KIWI_MODEL", async () => {
    // Given a complete cached model and resolvable WASM
    const xdg = await tempDir("mailcrawl-kiwi-inspect-");
    const modelDir = await plantModel(join(xdg, "mailcrawl", "kiwi-model", "0.23.0", "cong", "base"));

    // When doctor inspects the Korean analyzer
    const inspection = inspectKoreanAnalyzer({ env: { XDG_CACHE_HOME: xdg, HOME: xdg } });

    // Then status is ready and the cache path is reported
    expect(inspection.status).toBe("ready");
    expect(inspection.modelDir).toBe(modelDir);
    expect(inspection.wasmPath?.endsWith("kiwi-wasm.wasm")).toBe(true);
  });

  it("includes korean analyzer status on doctor --json without changing the semantic recommendation", async () => {
    // Given an empty data directory
    const dataDir = await tempDir("mailcrawl-cli-doctor-korean-");

    // When doctor --json runs
    const result = await run("node", ["dist/cli/index.js", "--data-dir", dataDir, "doctor", "--json"]);
    const output = JSON.parse(result.stdout) as {
      korean?: { status?: string };
      recommendation: string;
    };

    // Then korean.status is present and the existing recommendation is unchanged
    expect(output.korean?.status).toMatch(/^(ready|missing-model|unresolved-wasm)$/u);
    expect(output.recommendation).toBe("run sync, then index before semantic search");
  });
});
