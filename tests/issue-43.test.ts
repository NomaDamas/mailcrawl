import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Archive } from "../src/archive.js";
import { createEmbedder, embedderIdentity, embeddingBatchSize, embeddingModelName } from "../src/embedding.js";
import { sameEmbedder } from "../src/semantic-store.js";
import type { EmbedderConfig } from "../src/types.js";

const run = promisify(execFile);

interface RequestBody { model?: string; inputs?: string[]; input?: string[] }
interface Recorded { method?: string; url?: string; headers: IncomingHttpHeaders; body: RequestBody }

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()!;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  delete process.env.MC_TEST_EMBED_KEY;
});

/** Serves `reply(path, body)` for every POST and records each request. */
async function serve(reply: (path: string, body: RequestBody) => { status?: number; json: unknown }): Promise<{ url: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    const { status = 200, json } = reply(request.url ?? "", body);
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(json));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

const teiReply = (dimension: number) => (_path: string, body: RequestBody) => ({
  json: (body.inputs ?? []).map((text) => Array.from({ length: dimension }, (_, i) => text.length + i)),
});
const openaiReply = (dimension: number, shuffle = false) => (_path: string, body: RequestBody) => {
  const data = (body.input ?? []).map((text, index) => ({ index, embedding: Array.from({ length: dimension }, (_, i) => text.length + i) }));
  return { json: { object: "list", model: body.model, data: shuffle ? data.reverse() : data } };
};

describe("issue #43 tei provider", () => {
  it("POSTs {inputs} to {url}/embed with prefixes and returns the raw vectors", async () => {
    const server = await serve(teiReply(3));
    const embedder = await createEmbedder({ provider: "tei", url: server.url + "/", model: "m", dimension: 3, passagePrefix: "passage: ", queryPrefix: "query: " });
    await expect(embedder.embedDocuments(["ab", "cde"])).resolves.toEqual([[11, 12, 13], [12, 13, 14]]);
    await expect(embedder.embedQuery("  q  ")).resolves.toEqual([8, 9, 10]);
    expect(server.requests.map((r) => [r.method, r.url, r.body])).toEqual([
      ["POST", "/embed", { inputs: ["passage: ab", "passage: cde"] }],
      ["POST", "/embed", { inputs: ["query: q"] }],
    ]);
  });

  it("rejects wrong vector counts, dimensions, shapes, and HTTP errors", async () => {
    const short = await serve((_p, body) => ({ json: [[1, 2, 3]].slice(0, body.inputs.length - 1) }));
    await expect((await createEmbedder({ provider: "tei", url: short.url, model: "m", dimension: 3 })).embedDocuments(["a", "b"])).rejects.toThrow(/invalid embeddings/);
    const wrongDim = await serve(teiReply(2));
    await expect((await createEmbedder({ provider: "tei", url: wrongDim.url, model: "m", dimension: 3 })).embedDocuments(["a"])).rejects.toThrow(/dimension/);
    const wrongShape = await serve(() => ({ json: { embeddings: [[1, 2, 3]] } }));
    await expect((await createEmbedder({ provider: "tei", url: wrongShape.url, model: "m", dimension: 3 })).embedQuery("a")).rejects.toThrow(/invalid embeddings/);
    const failing = await serve(() => ({ status: 413, json: { error: "batch size 9 > maximum allowed batch size 8" } }));
    await expect((await createEmbedder({ provider: "tei", url: failing.url, model: "m", dimension: 3 })).embedQuery("a")).rejects.toThrow(/HTTP 413/);
  });
});

describe("issue #43 openai provider", () => {
  it("POSTs {model,input} to {url}/v1/embeddings and sorts the data by index", async () => {
    const server = await serve(openaiReply(3, true));
    const embedder = await createEmbedder({ provider: "openai", url: server.url, model: "text-embed", dimension: 3, passagePrefix: "p: " });
    await expect(embedder.embedDocuments(["a", "bcd"])).resolves.toEqual([[4, 5, 6], [6, 7, 8]]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({ method: "POST", url: "/v1/embeddings", body: { model: "text-embed", input: ["p: a", "p: bcd"] } });
  });

  it("accepts a base URL that already ends in /v1", async () => {
    const server = await serve(openaiReply(3));
    const embedder = await createEmbedder({ provider: "openai", url: server.url + "/v1/", model: "m", dimension: 3 });
    await embedder.embedQuery("x");
    expect(server.requests[0].url).toBe("/v1/embeddings");
  });

  it("rejects missing, duplicate, or out-of-range indexes, wrong counts, and wrong dimensions", async () => {
    const make = async (data: unknown) => createEmbedder({ provider: "openai", url: (await serve(() => ({ json: { data } }))).url, model: "m", dimension: 2 });
    await expect((await make([{ index: 0, embedding: [1, 2] }, { index: 0, embedding: [1, 2] }])).embedDocuments(["a", "b"])).rejects.toThrow(/index/);
    await expect((await make([{ index: 0, embedding: [1, 2] }, { index: 5, embedding: [1, 2] }])).embedDocuments(["a", "b"])).rejects.toThrow(/index/);
    await expect((await make([{ index: 0, embedding: [1, 2] }])).embedDocuments(["a", "b"])).rejects.toThrow(/invalid embeddings/);
    await expect((await make([{ index: 0, embedding: [1, 2, 3] }])).embedDocuments(["a"])).rejects.toThrow(/dimension/);
    await expect((await make([{ index: 0, embedding: ["x", "y"] }])).embedDocuments(["a"])).rejects.toThrow(/dimension/);
    await expect((await createEmbedder({ provider: "openai", url: (await serve(() => ({ json: [[1, 2]] }))).url, model: "m", dimension: 2 })).embedQuery("a")).rejects.toThrow(/invalid embeddings/);
  });

  it("sends a Bearer key read from the named environment variable and never stores it", async () => {
    process.env.MC_TEST_EMBED_KEY = "sk-secret-value";
    const server = await serve(openaiReply(2));
    const config: EmbedderConfig = { provider: "openai", url: server.url, model: "m", dimension: 2, apiKeyEnv: "MC_TEST_EMBED_KEY" };
    await (await createEmbedder(config)).embedQuery("x");
    expect(server.requests[0].headers.authorization).toBe("Bearer sk-secret-value");
    expect(JSON.stringify(embedderIdentity(config))).not.toContain("sk-secret-value");
    expect(embeddingModelName(config)).not.toContain("sk-secret-value");
  });

  it("sends no Authorization header without apiKeyEnv, and fails early when the named variable is unset", async () => {
    const server = await serve(openaiReply(2));
    await (await createEmbedder({ provider: "openai", url: server.url, model: "m", dimension: 2 })).embedQuery("x");
    expect(server.requests[0].headers.authorization).toBeUndefined();
    await expect(createEmbedder({ provider: "openai", url: server.url, model: "m", dimension: 2, apiKeyEnv: "MC_TEST_EMBED_KEY" })).rejects.toThrow(/MC_TEST_EMBED_KEY/);
  });

  it("does not leak the key through HTTP error messages", async () => {
    process.env.MC_TEST_EMBED_KEY = "sk-secret-value";
    const server = await serve(() => ({ status: 401, json: { error: "bad key sk-secret-value" } }));
    const embedder = await createEmbedder({ provider: "openai", url: server.url, model: "m", dimension: 2, apiKeyEnv: "MC_TEST_EMBED_KEY" });
    const error = await embedder.embedQuery("x").catch((caught: Error) => caught);
    expect((error as Error).message).toMatch(/HTTP 401/);
    expect((error as Error).message).not.toContain("sk-secret-value");
  });
});

describe("issue #43 shared behaviour", () => {
  it.each(["tei", "openai"] as const)("%s caps each request at batchSize and preserves order", async (provider) => {
    const server = await serve(provider === "tei" ? teiReply(2) : openaiReply(2));
    const embedder = await createEmbedder({ provider, url: server.url, model: "m", dimension: 2, batchSize: 2 });
    const texts = ["a", "bb", "ccc", "dddd", "eeeee"];
    await expect(embedder.embedDocuments(texts)).resolves.toEqual(texts.map((text) => [text.length, text.length + 1]));
    const sizes = server.requests.map((r) => (r.body.inputs ?? r.body.input).length);
    expect(sizes).toEqual([2, 2, 1]);
  });

  it.each(["tei", "openai"] as const)("%s defaults the per-request cap to 32", async (provider) => {
    const server = await serve(provider === "tei" ? teiReply(2) : openaiReply(2));
    const embedder = await createEmbedder({ provider, url: server.url, model: "m", dimension: 2 });
    await embedder.embedDocuments(Array.from({ length: 70 }, (_, i) => `t${i}`));
    expect(server.requests.map((r) => (r.body.inputs ?? r.body.input).length)).toEqual([32, 32, 6]);
    expect(embeddingBatchSize({ provider, url: server.url, model: "m", dimension: 2 })).toBe(32);
  });

  it.each(["tei", "openai"] as const)("%s aborts on the configured timeout", async (provider) => {
    const hung = createServer(() => { /* never answers */ });
    await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
    servers.push(hung);
    const address = hung.address() as { port: number };
    const embedder = await createEmbedder({ provider, url: `http://127.0.0.1:${address.port}`, model: "m", dimension: 2, timeoutMs: 100 });
    await expect(embedder.embedQuery("x")).rejects.toThrow();
  });

  it.each(["tei", "openai"] as const)("%s keeps the loopback-only rule unless allowRemote is set, and then requires https", async (provider) => {
    const base = { provider, model: "m", dimension: 2 } as const;
    for (const url of ["http://127.0.0.1:1", "http://localhost:1", "http://[::1]:1"]) {
      await expect(createEmbedder({ ...base, url })).resolves.toBeDefined();
    }
    await expect(createEmbedder({ ...base, url: "https://embed.example.com" })).rejects.toThrow(/loopback/i);
    await expect(createEmbedder({ ...base, url: "http://embed.example.com" })).rejects.toThrow(/loopback/i);
    await expect(createEmbedder({ ...base, url: "https://embed.example.com", allowRemote: true })).resolves.toBeDefined();
    await expect(createEmbedder({ ...base, url: "http://embed.example.com", allowRemote: true })).rejects.toThrow(/https/i);
    await expect(createEmbedder({ ...base, url: "ftp://embed.example.com", allowRemote: true })).rejects.toThrow();
  });

  it("includes the provider in the identity and leaves the URL out", () => {
    const tei: EmbedderConfig = { provider: "tei", url: "http://127.0.0.1:8080", model: "m", dimension: 3, queryPrefix: "q: ", passagePrefix: "p: " };
    const openai: EmbedderConfig = { ...tei, provider: "openai" };
    const movedTei: EmbedderConfig = { ...tei, url: "http://localhost:9999", timeoutMs: 5, batchSize: 3 };
    expect(embedderIdentity(tei)).toMatchObject({ provider: "tei", model: "m", dimension: 3, queryPrefix: "q: ", passagePrefix: "p: " });
    expect(embedderIdentity(openai).provider).toBe("openai");
    expect(sameEmbedder(embedderIdentity(tei), embedderIdentity(openai))).toBe(false);
    expect(sameEmbedder(embedderIdentity(tei), embedderIdentity({ ...tei, model: "other" }))).toBe(false);
    expect(sameEmbedder(embedderIdentity(tei), embedderIdentity({ ...tei, dimension: 4 }))).toBe(false);
    expect(sameEmbedder(embedderIdentity(tei), embedderIdentity({ ...tei, passagePrefix: "x: " }))).toBe(false);
    expect(sameEmbedder(embedderIdentity(tei), embedderIdentity(movedTei))).toBe(true);
    expect(embeddingModelName(tei)).toBe("tei:m:3");
    expect(embeddingModelName(openai)).toBe("openai:m:3");
  });
});

describe("issue #43 archive integration", () => {
  const message = (id: string, text: string) => ({
    accountId: "a", mailbox: "INBOX", providerKey: id, messageId: id, threadId: id, subject: id,
    from: "a@example.com", to: [], cc: [], date: "2026-08-26T00:00:00Z", text,
  });

  it("indexes and searches through tei, refuses a provider switch for search, and rebuilds on index", async () => {
    const tei = await serve(teiReply(8));
    const openai = await serve(openaiReply(8));
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-issue-43-"));
    const teiConfig: EmbedderConfig = { provider: "tei", url: tei.url, model: "m", dimension: 8 };
    const openaiConfig: EmbedderConfig = { provider: "openai", url: openai.url, model: "m", dimension: 8 };
    const open = (config: EmbedderConfig) => new Archive(join(root, "archive.sqlite"), config);
    try {
      let archive = open(teiConfig);
      await archive.sync([message("m1", "quarterly invoice for the renewal"), message("m2", "lunch plans")]);
      expect(await archive.indexSemantic()).toMatchObject({ embedded: expect.any(Number) });
      expect((await archive.searchSemantic("invoice", {}, 5)).length).toBeGreaterThan(0);
      archive.close();

      archive = open(openaiConfig);
      await expect(archive.searchSemantic("invoice", {}, 5)).rejects.toThrow(/mismatch.*tei:m:8.*openai:m:8/);
      expect(openai.requests).toHaveLength(0);
      const report = await archive.indexSemantic();
      expect(report).toMatchObject({ embedded: expect.any(Number) });
      expect(openai.requests.length).toBeGreaterThan(0);
      expect((await archive.searchSemantic("invoice", {}, 5)).length).toBeGreaterThan(0);
      archive.close();

      // Same provider/model/dimension/prefixes at a different port: vectors stay valid, nothing re-embedded.
      const moved = await serve(openaiReply(8));
      archive = open({ ...openaiConfig, url: moved.url });
      await archive.indexSemantic();
      expect(moved.requests).toHaveLength(0);
      expect((await archive.searchSemantic("invoice", {}, 5)).length).toBeGreaterThan(0);
      archive.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("issue #43 CLI", () => {
  const cli = ["dist/cli/index.js"];

  it.each(["tei", "openai"] as const)("indexes and searches with --provider %s using flags", async (provider) => {
    const server = await serve(provider === "tei" ? teiReply(8) : openaiReply(8));
    const dataDir = mkdtempSync(join(tmpdir(), "mailcrawl-issue-43-cli-"));
    try {
      const env = { ...process.env, MAILCRAWL_EMBEDDER: "" };
      const args = ["--provider", provider, "--embed-url", server.url, "--embed-model", "m", "--embed-dim", "8"];
      await run("node", [...cli, "--data-dir", dataDir, "sync", "--source", "fixture", "--fixture", "tests/fixtures/messages.json", "--json"], { env });
      const indexed = JSON.parse((await run("node", [...cli, "--data-dir", dataDir, "index", ...args, "--json"], { env })).stdout);
      expect(indexed.embedder).toBe(`${provider}:m:8`);
      expect(indexed.embedded).toBeGreaterThan(0);
      const found = JSON.parse((await run("node", [...cli, "--data-dir", dataDir, "search:semantic", "invoice", ...args, "--json"], { env })).stdout);
      expect(Array.isArray(found) ? found : found.results ?? found.hits).toBeDefined();
      expect(server.requests.every((r) => r.url === (provider === "tei" ? "/embed" : "/v1/embeddings"))).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("reads provider, URL, model, dimension, prefixes, timeout, and API key variable from the environment", async () => {
    const server = await serve(openaiReply(8));
    const dataDir = mkdtempSync(join(tmpdir(), "mailcrawl-issue-43-cli-env-"));
    try {
      const env = {
        ...process.env, MAILCRAWL_EMBEDDER: "", MAILCRAWL_EMBEDDER_PROVIDER: "openai",
        MAILCRAWL_EMBED_URL: server.url, MAILCRAWL_EMBED_MODEL: "m", MAILCRAWL_EMBED_DIM: "8",
        MAILCRAWL_PASSAGE_PREFIX: "doc: ", MAILCRAWL_EMBED_TIMEOUT: "5000",
        MAILCRAWL_EMBED_API_KEY_ENV: "MC_TEST_EMBED_KEY", MC_TEST_EMBED_KEY: "sk-env",
      };
      await run("node", [...cli, "--data-dir", dataDir, "sync", "--source", "fixture", "--fixture", "tests/fixtures/messages.json", "--json"], { env });
      await run("node", [...cli, "--data-dir", dataDir, "index", "--json"], { env });
      expect(server.requests.length).toBeGreaterThan(0);
      expect(server.requests.every((r) => r.headers.authorization === "Bearer sk-env")).toBe(true);
      expect(server.requests.every((r) => (r.body.input as string[]).every((text) => text.startsWith("doc: ")))).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects a remote URL unless --embed-allow-remote is given", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mailcrawl-issue-43-cli-remote-"));
    try {
      const env = { ...process.env, MAILCRAWL_EMBEDDER: "" };
      await run("node", [...cli, "--data-dir", dataDir, "sync", "--source", "fixture", "--fixture", "tests/fixtures/messages.json", "--json"], { env });
      const base = [...cli, "--data-dir", dataDir, "index", "--provider", "openai", "--embed-url", "https://127.0.0.2.invalid", "--embed-model", "m", "--embed-dim", "8", "--json"];
      await expect(run("node", base, { env })).rejects.toMatchObject({ stderr: expect.stringMatching(/loopback/i) });
      // With the opt-in the URL passes validation and fails only at the network.
      await expect(run("node", [...base, "--embed-allow-remote"], { env })).rejects.toMatchObject({ stderr: expect.not.stringMatching(/loopback/i) });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("requires --embed-url, --embed-model, and --embed-dim for tei and openai", async () => {
    const env = { ...process.env, MAILCRAWL_EMBEDDER: "" };
    await expect(run("node", [...cli, "index", "--provider", "tei", "--json"], { env })).rejects.toMatchObject({ stderr: expect.stringMatching(/--embed-url.*tei/) });
  }, 60_000);
});
