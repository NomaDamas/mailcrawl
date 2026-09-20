import { execFile } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export const KIWI_MODEL_VERSION = "0.23.0" as const;
export const KIWI_MODEL_URL = `https://github.com/bab2min/Kiwi/releases/download/v${KIWI_MODEL_VERSION}/kiwi_model_v${KIWI_MODEL_VERSION}_base.tgz`;
export const KIWI_MODEL_FILES = [
  "cong.mdl",
  "sj.morph",
  "default.dict",
  "multi.dict",
  "extract.mdl",
  "combiningRule.txt",
  "typo.dict",
] as const;

export class KiwiWasmUnresolvedError extends Error {
  readonly name = "KiwiWasmUnresolvedError";
  constructor() {
    super("Could not resolve kiwi-nlp WASM; set MAILCRAWL_KIWI_WASM.");
  }
}

export class KiwiModelMissingError extends Error {
  readonly name = "KiwiModelMissingError";
  constructor(
    message = "Korean analyzer requires MAILCRAWL_KIWI_MODEL (Kiwi model dir, e.g. cong/base from Kiwi v0.23.x). Set it or run `mailcrawl doctor --fix` to download it.",
  ) {
    super(message);
  }
}

export type KiwiEnv = NodeJS.Dict<string>;

export type ResolveKiwiWasmOptions = {
  readonly env?: KiwiEnv;
  readonly fromModuleUrl?: string;
  readonly argv1?: string;
};

export type ResolveKiwiModelOptions = {
  readonly env?: KiwiEnv;
  readonly fetchTarball?: (url: string) => Promise<Buffer>;
  readonly extractTarball?: (archive: Buffer, dest: string) => Promise<void>;
};

export type KoreanAnalyzerInspection = {
  readonly status: "ready" | "missing-model" | "unresolved-wasm";
  readonly wasmPath?: string;
  readonly modelDir?: string;
};

export function resolveKiwiWasmPath(options: ResolveKiwiWasmOptions = {}): string {
  const env = options.env ?? process.env;
  const override = present(env.MAILCRAWL_KIWI_WASM);
  if (override) {
    if (!existsSync(override)) throw new KiwiWasmUnresolvedError();
    return realpathSync(override);
  }
  for (const anchor of wasmAnchors(options.fromModuleUrl ?? import.meta.url, options.argv1 ?? process.argv[1])) {
    const resolved = resolveWasmFromAnchor(anchor);
    if (resolved) return resolved;
  }
  throw new KiwiWasmUnresolvedError();
}

export async function resolveKiwiModelDir(options: ResolveKiwiModelOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const override = present(env.MAILCRAWL_KIWI_MODEL);
  if (override) {
    if (isCompleteModelDir(override)) return override;
    throw new KiwiModelMissingError(
      `Korean analyzer requires MAILCRAWL_KIWI_MODEL (Kiwi model dir, e.g. cong/base from Kiwi v0.23.x): ${override} is missing required model files. Set it or run \`mailcrawl doctor --fix\` to download it.`,
    );
  }
  const cache = cacheRoot(env);
  const cached = findModelDir(cache);
  if (cached) return cached;
  return provisionKiwiModel(cache, options);
}

export function inspectKoreanAnalyzer(options: ResolveKiwiWasmOptions = {}): KoreanAnalyzerInspection {
  const env = options.env ?? process.env;
  let wasmPath: string;
  try {
    wasmPath = resolveKiwiWasmPath(options);
  } catch (error) {
    if (error instanceof KiwiWasmUnresolvedError) return { status: "unresolved-wasm" };
    throw error;
  }
  const override = present(env.MAILCRAWL_KIWI_MODEL);
  if (override && isCompleteModelDir(override)) return { status: "ready", wasmPath, modelDir: override };
  const cached = findModelDir(cacheRoot(env));
  if (cached) return { status: "ready", wasmPath, modelDir: cached };
  return { status: "missing-model", wasmPath };
}

function present(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function cacheRoot(env: KiwiEnv): string {
  const explicit = present(env.MAILCRAWL_KIWI_CACHE);
  if (explicit) return explicit;
  const home = present(env.XDG_CACHE_HOME) ?? join(present(env.HOME) ?? homedir(), ".cache");
  return join(home, "mailcrawl", "kiwi-model", KIWI_MODEL_VERSION);
}

function isCompleteModelDir(directory: string): boolean {
  return existsSync(directory) && KIWI_MODEL_FILES.every((name) => existsSync(join(directory, name)));
}

function findModelDir(root: string, depth = 0): string | undefined {
  if (!existsSync(root) || depth > 5) return undefined;
  if (isCompleteModelDir(root)) return root;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return undefined;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findModelDir(join(root, entry.name), depth + 1);
    if (found) return found;
  }
  return undefined;
}

function wasmAnchors(fromModuleUrl: string, argv1: string | undefined): readonly string[] {
  const anchors = [fromModuleUrl];
  if (!argv1) return anchors;
  try {
    anchors.push(pathToFileURL(realpathSync(argv1)).href);
  } catch (error) {
    if (!(error instanceof Error && "code" in error)) throw error;
    try {
      anchors.push(pathToFileURL(argv1).href);
    } catch (inner) {
      if (!(inner instanceof Error)) throw inner;
    }
  }
  return anchors;
}

function resolveWasmFromAnchor(anchor: string): string | undefined {
  try {
    const resolved = createRequire(anchor).resolve("kiwi-nlp/dist/kiwi-wasm.wasm");
    if (existsSync(resolved)) return realpathSync(resolved);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND") {
      // Fall through to a filesystem walk from this anchor.
    } else if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ERR_INVALID_ARG_VALUE")) {
      // Fall through.
    } else {
      throw error;
    }
  }
  let dir: string;
  try {
    dir = anchor.startsWith("file:") ? dirname(fileURLToPath(anchor)) : dirname(anchor);
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
  for (let depth = 0; depth < 8; depth += 1) {
    const packaged = join(dir, "node_modules", "kiwi-nlp", "dist", "kiwi-wasm.wasm");
    if (existsSync(packaged)) return realpathSync(packaged);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

async function provisionKiwiModel(cache: string, options: ResolveKiwiModelOptions): Promise<string> {
  const fetchTarball = options.fetchTarball ?? defaultFetchTarball;
  const extractTarball = options.extractTarball ?? defaultExtractTarball;
  let archive: Buffer;
  try {
    archive = await fetchTarball(KIWI_MODEL_URL);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new KiwiModelMissingError(
      `Korean analyzer requires MAILCRAWL_KIWI_MODEL (Kiwi model dir, e.g. cong/base from Kiwi v0.23.x). Download failed from ${KIWI_MODEL_URL}: ${reason}. Set MAILCRAWL_KIWI_MODEL or run \`mailcrawl doctor --fix\`.`,
    );
  }
  const staging = await mkdtemp(join(tmpdir(), "mailcrawl-kiwi-extract-"));
  try {
    await extractTarball(archive, staging);
    if (!findModelDir(staging)) {
      throw new KiwiModelMissingError(
        `Korean analyzer requires MAILCRAWL_KIWI_MODEL (Kiwi model dir, e.g. cong/base from Kiwi v0.23.x). Downloaded archive did not contain required files. Set MAILCRAWL_KIWI_MODEL or run \`mailcrawl doctor --fix\`.`,
      );
    }
    await mkdir(dirname(cache), { recursive: true });
    await rm(cache, { recursive: true, force: true });
    await rename(staging, cache);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error instanceof KiwiModelMissingError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new KiwiModelMissingError(
      `Korean analyzer requires MAILCRAWL_KIWI_MODEL (Kiwi model dir, e.g. cong/base from Kiwi v0.23.x). Failed to install model into ${cache}: ${reason}.`,
    );
  }
  const installed = findModelDir(cache);
  if (!installed) {
    throw new KiwiModelMissingError(
      `Korean analyzer requires MAILCRAWL_KIWI_MODEL (Kiwi model dir, e.g. cong/base from Kiwi v0.23.x). Failed to install model into ${cache}.`,
    );
  }
  return installed;
}

async function defaultFetchTarball(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(300_000),
    headers: { "user-agent": "mailcrawl (@nomadamas/mailcrawl)", accept: "application/octet-stream" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function defaultExtractTarball(archive: Buffer, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const tarball = join(dest, "model.tgz");
  await writeFile(tarball, archive);
  try {
    await run("tar", ["-xzf", tarball, "-C", dest]);
  } finally {
    await rm(tarball, { force: true });
  }
}
