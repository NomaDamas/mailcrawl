import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbedder, defaultInlConfig, defaultNativeConfig, discoverInlDaemon, embedderIdentity } from "../src/embedding.js";
import { sameEmbedder } from "../src/semantic-store.js";

const MODEL = "Qwen/Qwen3-Embedding-0.6B";
const HEALTH_TIMEOUT_MS = 2000;

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()!;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

interface RecordedRequest { url?: string; body: { model?: string; input?: string[] } }

/** A fake inl daemon: answers `/health` with the given JSON and records `/v1/embeddings` posts. */
async function fakeDaemon(health: Record<string, unknown>, bind = "127.0.0.1", maxChars?: number): Promise<{ port: number; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify(health));
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string; input?: string[] };
    requests.push({ url: request.url, body });
    if (maxChars !== undefined && (body.input ?? []).some((text) => text.length > maxChars)) {
      response.statusCode = 413;
      response.end(JSON.stringify({ error: { code: "context_length_exceeded", message: "maximum context length is 2048 tokens" } }));
      return;
    }
    const data = (body.input ?? []).map((_text, index) => ({ index, embedding: [index, index + 1] }));
    response.end(JSON.stringify({ object: "list", model: body.model, data }));
  });
  await new Promise<void>((resolve) => server.listen(0, bind, resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake daemon did not bind");
  return { port: address.port, requests };
}

/** Writes one `<serveRoot>/<instance>/{host,port}` state dir, as `inl serve` does. */
function stateDir(serveRoot: string, instance: string, host: string, port?: number): void {
  const dir = join(serveRoot, instance);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "host"), `${host}\n`);
  if (port !== undefined) writeFileSync(join(dir, "port"), `${port}\n`);
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Runs `body` with the home and Windows app-data variables pointed at a throwaway dir, then restores them. */
async function withHome<T>(home: string, body: () => Promise<T>): Promise<T> {
  const keys = ["HOME", "USERPROFILE", "LOCALAPPDATA"] as const;
  const previous = keys.map((key) => process.env[key]);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LOCALAPPDATA = join(home, "AppData", "Local");
  try {
    return await body();
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
}

/** The serve root under an isolated home, as `inlCacheRoot` resolves it on this platform. */
const serveRootIn = (home: string): string =>
  process.platform === "win32" ? join(home, "AppData", "Local", "im-not-llm", "serve") : join(home, ".cache", "im-not-llm", "serve");

describe("inl daemon discovery", () => {
  it("matches a dense daemon with a matching model over loopback, ignoring the instance name", async () => {
    const root = tempDir("mailcrawl-inl-root-");
    try {
      const good = await fakeDaemon({ status: "ok", kind: "dense", model_id: MODEL.toLowerCase(), dimension: 2 });
      stateDir(root, "device-metal-dtype-fp16-a1b2", "127.0.0.1", good.port);
      // Matching is case-insensitive; the daemon's reported id is returned as-is.
      await expect(discoverInlDaemon({ serveRoot: root, model: MODEL })).resolves.toEqual({
        host: "127.0.0.1", port: good.port, url: `http://127.0.0.1:${good.port}`, modelId: MODEL.toLowerCase(), dimension: 2,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a missing kind as dense and defaults the host to 127.0.0.1", async () => {
    const root = tempDir("mailcrawl-inl-root-");
    try {
      const daemon = await fakeDaemon({ status: "ok", model_id: MODEL, dimension: 3 });
      const dir = join(root, "instance");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "port"), `${daemon.port}\n`);
      const found = await discoverInlDaemon({ serveRoot: root, model: MODEL });
      expect(found).toMatchObject({ host: "127.0.0.1", port: daemon.port, dimension: 3 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores stale, non-loopback, unhealthy, wrong-kind, and wrong-model state dirs", async () => {
    const root = tempDir("mailcrawl-inl-root-");
    try {
      const good = await fakeDaemon({ status: "ok", kind: "dense", model_id: MODEL, dimension: 2 });
      const loading = await fakeDaemon({ status: "loading" });
      const sparse = await fakeDaemon({ status: "ok", kind: "sparse", model_id: MODEL, dimension: 36282 });
      const otherModel = await fakeDaemon({ status: "ok", kind: "dense", model_id: "org/proprietary" });
      stateDir(root, "0-no-port", "127.0.0.1");                       // stale lock, no port yet
      stateDir(root, "1-non-loopback", "192.168.1.5", good.port);     // reachable but not loopback
      stateDir(root, "2-loading", "127.0.0.1", loading.port);         // status != ok
      stateDir(root, "3-sparse", "127.0.0.1", sparse.port);           // wrong kind
      stateDir(root, "4-other-model", "127.0.0.1", otherModel.port);  // wrong model
      stateDir(root, "5-dead", "127.0.0.1", 9);                       // nothing listening
      stateDir(root, "6-good", "127.0.0.1", good.port);               // the only valid daemon
      const found = await discoverInlDaemon({ serveRoot: root, model: MODEL, timeoutMs: HEALTH_TIMEOUT_MS });
      expect(found).toMatchObject({ host: "127.0.0.1", port: good.port, dimension: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts the IPv6 loopback host and brackets it in the URL", async () => {
    const root = tempDir("mailcrawl-inl-root-");
    try {
      const daemon = await fakeDaemon({ status: "ok", kind: "dense", model_id: MODEL, dimension: 2 }, "::1");
      stateDir(root, "instance", "::1", daemon.port);
      const found = await discoverInlDaemon({ serveRoot: root, model: MODEL, timeoutMs: HEALTH_TIMEOUT_MS });
      expect(found).toMatchObject({ host: "::1", port: daemon.port, dimension: 2 });
      expect(found?.url).toBe(`http://[::1]:${daemon.port}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns undefined for a missing or empty serve root without starting anything", async () => {
    const root = tempDir("mailcrawl-inl-root-");
    try {
      await expect(discoverInlDaemon({ serveRoot: join(root, "absent"), model: MODEL })).resolves.toBeUndefined();
      mkdirSync(join(root, "serve"), { recursive: true });
      await expect(discoverInlDaemon({ serveRoot: join(root, "serve"), model: MODEL })).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("inl embedder", () => {
  it("embeds through the daemon's OpenAI-compatible /v1/embeddings with prefixes", async () => {
    const home = tempDir("mailcrawl-inl-home-");
    try {
      await withHome(home, async () => {
        const daemon = await fakeDaemon({ status: "ok", kind: "dense", model_id: MODEL, dimension: 2 });
        stateDir(serveRootIn(home), "instance", "127.0.0.1", daemon.port);
        const embedder = await createEmbedder({ provider: "inl", model: MODEL, passagePrefix: "p: " });
        await expect(embedder.embedDocuments(["ab", "c"])).resolves.toEqual([[0, 1], [1, 2]]);
        expect(daemon.requests).toEqual([{ url: "/v1/embeddings", body: { model: MODEL, input: ["p: ab", "p: c"] } }]);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails with an actionable message when an explicit inl daemon is not running", async () => {
    const home = tempDir("mailcrawl-inl-home-");
    try {
      await withHome(home, async () => {
        await expect(createEmbedder({ provider: "inl", model: MODEL })).rejects.toThrow(/inl serve/);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("the default provider embeds through the daemon when one answers", async () => {
    const home = tempDir("mailcrawl-inl-home-");
    try {
      await withHome(home, async () => {
        const daemon = await fakeDaemon({ status: "ok", kind: "dense", model_id: MODEL, dimension: 2 });
        stateDir(serveRootIn(home), "instance", "127.0.0.1", daemon.port);
        const embedder = await createEmbedder(defaultInlConfig());
        await expect(embedder.embedQuery("q")).resolves.toEqual([0, 1]);
        expect(daemon.requests[0]).toMatchObject({ url: "/v1/embeddings", body: { model: MODEL, input: ["q"] } });
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("the default provider fails with an inl serve hint when no daemon answers, and never falls back to ONNX", async () => {
    const home = tempDir("mailcrawl-inl-home-");
    try {
      await withHome(home, async () => {
        await expect(discoverInlDaemon({ model: MODEL })).resolves.toBeUndefined();
        await expect(createEmbedder(defaultInlConfig())).rejects.toThrow(/inl serve/);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("inl embedder identity", () => {
  it("is the inl space for the default config and apart from the in-process ONNX embedder", () => {
    const native = embedderIdentity(defaultNativeConfig());
    const inl = embedderIdentity({ provider: "inl", model: MODEL });
    expect(inl).toMatchObject({ provider: "inl", model: MODEL, dimension: 1024, runtimeBuild: "mailcrawl-inl-daemon" });
    expect(sameEmbedder(inl, embedderIdentity(defaultInlConfig()))).toBe(true);
    expect(sameEmbedder(inl, native)).toBe(false);
  });
});

describe("inl embedder over-context inputs", () => {
  it("splits a rejected document, embeds the halves and returns one unit vector for it", async () => {
    const home = tempDir("mailcrawl-inl-home-");
    try {
      await withHome(home, async () => {
        const daemon = await fakeDaemon({ status: "ok", kind: "dense", model_id: MODEL, dimension: 2 }, "127.0.0.1", 100);
        stateDir(serveRootIn(home), "instance", "127.0.0.1", daemon.port);
        const embedder = await createEmbedder({ provider: "inl", model: MODEL });
        const long = `${"가나다라 ".repeat(60)}`; // 300 chars, over the 100-char fake limit
        const vectors = await embedder.embedDocuments(["short", long]);
        expect(vectors).toHaveLength(2);
        expect(vectors[1]).toHaveLength(2);
        expect(Math.hypot(...vectors[1]!)).toBeCloseTo(1, 6);
        // Nothing sent to the daemon was over its limit once the rejection was handled.
        const accepted = daemon.requests.filter((request) => (request.body.input ?? []).every((text) => text.length <= 100));
        expect(accepted.length).toBeGreaterThan(0);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not split anything the daemon accepts", async () => {
    const home = tempDir("mailcrawl-inl-home-");
    try {
      await withHome(home, async () => {
        const daemon = await fakeDaemon({ status: "ok", kind: "dense", model_id: MODEL, dimension: 2 }, "127.0.0.1", 1000);
        stateDir(serveRootIn(home), "instance", "127.0.0.1", daemon.port);
        const embedder = await createEmbedder({ provider: "inl", model: MODEL });
        await embedder.embedDocuments(["a", "b"]);
        expect(daemon.requests).toHaveLength(1);
        expect(daemon.requests[0]!.body.input).toEqual(["a", "b"]);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails clearly when a single character is still rejected", async () => {
    const home = tempDir("mailcrawl-inl-home-");
    try {
      await withHome(home, async () => {
        const daemon = await fakeDaemon({ status: "ok", kind: "dense", model_id: MODEL, dimension: 2 }, "127.0.0.1", 0);
        stateDir(serveRootIn(home), "instance", "127.0.0.1", daemon.port);
        const embedder = await createEmbedder({ provider: "inl", model: MODEL });
        await expect(embedder.embedDocuments(["x"])).rejects.toThrow(/413/);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
