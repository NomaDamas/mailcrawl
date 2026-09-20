import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "../src/archive.js";
import { LanceSemanticStore, sameEmbedder } from "../src/semantic-store.js";
import { defaultNativeConfig, embedderIdentity, embeddingBatchSize, legacyEmbedderConfig, LEGACY_EMBEDDING_MODEL } from "../src/embedding.js";
import type { EmbedderConfig, EmbedderIdentity, MailMessage, NativeEmbedderConfig } from "../src/types.js";

const recorder = vi.hoisted(() => ({
  callSizes: [] as number[],
  failAfterCall: Number.POSITIVE_INFINITY,
}));

vi.mock("../src/embedding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/embedding.js")>();
  return {
    ...actual,
    // A recording mock embedder: deterministic axis vectors sized to match the
    // active profile (128 for mock/native test identity, 768 for legacy-onnx).
    createEmbedder: async (config?: EmbedderConfig) => {
      const dimension = config?.provider === "legacy-onnx" ? 768 : 128;
      return {
        embedDocuments: async (texts: string[]) => {
          recorder.callSizes.push(texts.length);
          if (recorder.callSizes.length > recorder.failAfterCall) throw new Error("injected embedder crash");
          return texts.map((text) => axisAt(text.charCodeAt(text.length - 1) % dimension, dimension));
        },
        embedQuery: async (query: string) => axisAt(query.charCodeAt(query.length - 1) % dimension, dimension),
      };
    },
  };
});

function axisAt(index: number, dimension = 128): number[] {
  const vector = new Array<number>(dimension).fill(0);
  vector[index] = 1;
  return vector;
}

function message(index: number, text: string, accountId = "gmail"): MailMessage {
  return {
    accountId, mailbox: "INBOX", providerKey: `p${index}`, messageId: `m${index}`,
    threadId: `t${index}`, subject: `Subject ${index}`, from: `from${index}@example.com`,
    to: ["to@example.com"], cc: [], date: "2026-08-26T10:00:00Z", text,
  };
}

const identityFile = (dataDir: string) => join(dataDir, "semantic.identity.json");

describe("issue #39: LanceDB semantic vector store", () => {
  it("stores vectors in a Lance table with a typed vector column and persisted identity", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mailcrawl-issue-39-store-"));
    try {
      const store = await LanceSemanticStore.open(dataDir, 128);
      const identity: EmbedderIdentity = { provider: "mock", model: "hash-128", dimension: 128, runtimeBuild: "mailcrawl-mock" };
      store.writeIdentity(identity);
      await store.upsert([
        { chunkId: "c1", vector: axisAt(0), contentHash: "h1", accountId: "a", mailbox: "INBOX", threadId: "t1", messageId: "m1", date: "2026-01-01", fromAddress: "x@example.com" },
        { chunkId: "c2", vector: axisAt(1), contentHash: "h2", accountId: "b", mailbox: "INBOX", threadId: "t2", messageId: "m2", date: "2026-02-01", fromAddress: "y@example.com" },
      ]);
      expect(await store.countRows()).toBe(2);
      expect((await store.contentHashes(["c1", "c2", "missing"])).get("c1")).toBe("h1");

      const all = await store.query(axisAt(0), {}, 10);
      expect(all[0]).toMatchObject({ chunkId: "c1", score: 1 });

      const filtered = await store.query(axisAt(0), { accountId: "b" }, 10);
      expect(filtered.map((hit) => hit.chunkId)).toEqual(["c2"]);

      const dated = await store.query(axisAt(1), { after: "2026-01-15" }, 10);
      expect(dated.map((hit) => hit.chunkId)).toEqual(["c2"]);

      await store.deleteChunkIds(["c2"]);
      expect(await store.countRows()).toBe(1);

      const persisted = JSON.parse(readFileSync(identityFile(dataDir), "utf8")) as EmbedderIdentity;
      expect(sameEmbedder(persisted, identity)).toBe(true);
      expect(existsSync(join(dataDir, "semantic.lance"))).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("opens existing stores read-only and reports none for fresh directories", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mailcrawl-issue-39-existing-"));
    try {
      expect(await LanceSemanticStore.openExisting(dataDir)).toBeUndefined();
      const store = await LanceSemanticStore.open(dataDir, 4);
      store.writeIdentity({ provider: "mock", model: "hash-128", dimension: 4, runtimeBuild: "t" });
      expect(await LanceSemanticStore.openExisting(dataDir)).toBeDefined();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects vectors that do not match the store dimension", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mailcrawl-issue-39-dim-"));
    try {
      const store = await LanceSemanticStore.open(dataDir, 8);
      await expect(store.upsert([
        { chunkId: "c1", vector: axisAt(0), contentHash: "h", accountId: "a", mailbox: "INBOX", threadId: "t", messageId: "m", date: "d", fromAddress: "f" },
      ])).rejects.toThrow(/dimension/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("issue #39: native embedder defaults and identity", () => {
  it("defaults to the in-process Qwen3 native profile with MinSync-style batching", () => {
    // The zero-config production default (under NODE_ENV=test the implicit
    // config maps to the mock embedder, so assert the native profile explicitly).
    const native = defaultNativeConfig();
    expect(native).toMatchObject({ model: "Qwen/Qwen3-Embedding-0.6B", dimension: 1024, device: "auto", dtype: "q4f16", batchSize: 4 });
    expect(embedderIdentity(native)).toMatchObject({ provider: "native", model: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024, runtimeBuild: "mailcrawl-native" });
    expect(embeddingBatchSize(native)).toBe(4);
    expect(embeddingBatchSize({ provider: "mock" })).toBe(32);
  });

  it("treats identity as data: provider, model, dimension, and prefixes define equality", () => {
    const base: EmbedderIdentity = { provider: "native", model: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024, runtimeBuild: "a" };
    expect(sameEmbedder(base, { ...base, runtimeBuild: "different" })).toBe(true);
    expect(sameEmbedder(base, { ...base, dimension: 768 })).toBe(false);
    expect(sameEmbedder(base, { ...base, queryPrefix: "q: " })).toBe(false);
    expect(sameEmbedder(base, undefined)).toBe(false);
  });
});

describe("issue #39: batched indexing with per-batch commits", () => {
  it("embeds in bounded batches and resumes from the committed state after a crash", async () => {
    recorder.callSizes = [];
    recorder.failAfterCall = 2;
    const dataDir = mkdtempSync(join(tmpdir(), "mailcrawl-issue-39-crash-"));
    const archive = new Archive(join(dataDir, "archive.sqlite"), { provider: "mock", batchSize: 4 });
    try {
      await archive.sync(Array.from({ length: 10 }, (_, index) => message(index, `body ${index}`)));

      await expect(archive.indexSemantic()).rejects.toThrow("injected embedder crash");

      expect(recorder.callSizes.length).toBeGreaterThan(1);
      expect(Math.max(...recorder.callSizes)).toBeLessThanOrEqual(4);
      const committed = archive.db.prepare("SELECT COUNT(*) AS count FROM embedding_queue WHERE state = 'complete'").get() as { count: number };
      expect(committed.count).toBe(recorder.callSizes.slice(0, 2).reduce((sum, size) => sum + size, 0));

      recorder.failAfterCall = Number.POSITIVE_INFINITY;
      const resumed = await archive.indexSemantic();
      expect(resumed.embedded).toBe(10 - committed.count);
      expect(archive.db.prepare("SELECT COUNT(*) AS count FROM embedding_queue WHERE state = 'pending'").get()).toMatchObject({ count: 0 });

      const hits = await archive.searchSemantic("body 3");
      expect(hits[0]?.score).toBeCloseTo(1, 5);
      expect(hits[0]?.snippet).toContain("body 3");
    } finally {
      archive.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("honors a configured batch size for the whole index run", async () => {
    recorder.callSizes = [];
    recorder.failAfterCall = Number.POSITIVE_INFINITY;
    const dataDir = mkdtempSync(join(tmpdir(), "mailcrawl-issue-39-batch-"));
    const archive = new Archive(join(dataDir, "archive.sqlite"), { provider: "mock", batchSize: 3 });
    try {
      await archive.sync(Array.from({ length: 9 }, (_, index) => message(index, `text ${index}`)));
      await archive.indexSemantic();
      expect(recorder.callSizes.every((size) => size <= 3)).toBe(true);
      expect(recorder.callSizes.length).toBeGreaterThan(1);
    } finally {
      archive.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("issue #39: embedder identity is data", () => {
  it("rebuilds the vector table from scratch when the identity changes", async () => {
    recorder.callSizes = [];
    recorder.failAfterCall = Number.POSITIVE_INFINITY;
    const dataDir = mkdtempSync(join(tmpdir(), "mailcrawl-issue-39-rebuild-"));
    const loopbackA: EmbedderConfig = { provider: "loopback-http", url: "http://localhost:4318/embed", model: "model-a", dimension: 128 };
    const loopbackB: EmbedderConfig = { provider: "loopback-http", url: "http://localhost:4318/embed", model: "model-b", dimension: 128 };
    let archive = new Archive(join(dataDir, "archive.sqlite"), loopbackA);
    try {
      await archive.sync([message(0, "vector content")]);
      await archive.indexSemantic();
      const identityBefore = JSON.parse(readFileSync(identityFile(dataDir), "utf8")) as EmbedderIdentity;
      archive.close();

      // Same dimension but a different model: never silent reuse.
      archive = new Archive(join(dataDir, "archive.sqlite"), loopbackB);
      const rebuilt = await archive.indexSemantic();
      expect(rebuilt.rebuilt).toBe(true);
      expect(rebuilt.embedded).toBe(1);
      const identityAfter = JSON.parse(readFileSync(identityFile(dataDir), "utf8")) as EmbedderIdentity;
      expect(identityAfter).not.toEqual(identityBefore);

      const again = await archive.indexSemantic({ rebuild: true });
      expect(again).toMatchObject({ rebuilt: true, embedded: 1 });
      expect(recorder.callSizes.at(-1)).toBe(1);
    } finally {
      archive.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rebuilds when the identity sidecar is missing next to an existing vector table", async () => {
    recorder.callSizes = [];
    recorder.failAfterCall = Number.POSITIVE_INFINITY;
    const dataDir = mkdtempSync(join(tmpdir(), "mailcrawl-issue-39-missing-identity-"));
    let archive = new Archive(join(dataDir, "archive.sqlite"), { provider: "mock" });
    try {
      await archive.sync([message(0, "orphaned identity content")]);
      expect(await archive.indexSemantic()).toMatchObject({ embedded: 1, reused: 0 });
      archive.close();

      rmSync(identityFile(dataDir));
      expect(existsSync(join(dataDir, "semantic.lance"))).toBe(true);

      archive = new Archive(join(dataDir, "archive.sqlite"), { provider: "mock" });
      expect(await archive.semanticSummary()).toMatchObject({ status: "rebuild-required" });
      expect(await archive.indexSemantic()).toMatchObject({ rebuilt: true, embedded: 1, reused: 0 });
      expect(JSON.parse(readFileSync(identityFile(dataDir), "utf8"))).toMatchObject({ provider: "mock", dimension: 128 });
    } finally {
      archive.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses to query a vector table built by a different embedder", async () => {
    recorder.failAfterCall = Number.POSITIVE_INFINITY;
    const dataDir = mkdtempSync(join(tmpdir(), "mailcrawl-issue-39-mismatch-"));
    let archive = new Archive(join(dataDir, "archive.sqlite"), { provider: "mock" });
    try {
      await archive.sync([message(0, "mismatch content")]);
      await archive.indexSemantic();
      archive.close();

      archive = new Archive(join(dataDir, "archive.sqlite"), { provider: "loopback-http", url: "http://localhost:4318/embed", model: "other", dimension: 128 });
      await expect(archive.searchSemantic("mismatch")).rejects.toThrow(/run mailcrawl index to rebuild/);
    } finally {
      archive.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("imports legacy JSON vectors when the legacy profile is explicitly active", async () => {
    recorder.failAfterCall = Number.POSITIVE_INFINITY;
    const dataDir = mkdtempSync(join(tmpdir(), "mailcrawl-issue-39-legacy-"));
    let archive = new Archive(join(dataDir, "archive.sqlite"));
    try {
      await archive.sync([message(0, "legacy content")]);
      const chunk = archive.db.prepare("SELECT chunk_id, content_hash FROM chunks").get() as { chunk_id: string; content_hash: string };
      // Simulate a pre-#39 archive: JSON vectors keyed by the legacy model name.
      archive.db.exec("CREATE TABLE IF NOT EXISTS semantic_vectors (chunk_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', vector TEXT NOT NULL)");
      archive.db.prepare("INSERT INTO semantic_vectors (chunk_id, content_hash, model, vector) VALUES (?, ?, ?, ?)")
        .run(chunk.chunk_id, chunk.content_hash, LEGACY_EMBEDDING_MODEL, JSON.stringify(axisAt(7, 768)));
      archive.close();

      archive = new Archive(join(dataDir, "archive.sqlite"), legacyEmbedderConfig());
      const report = await archive.indexSemantic();
      expect(report).toMatchObject({ embedded: 0, reused: 1 });
      expect(archive.db.prepare("SELECT name FROM sqlite_master WHERE name = 'semantic_vectors'").get()).toBeUndefined();
      const identity = JSON.parse(readFileSync(identityFile(dataDir), "utf8")) as EmbedderIdentity;
      expect(identity).toMatchObject({ provider: "legacy-onnx", dimension: 768 });
      expect(await archive.searchSemantic("legacy content")).toHaveLength(1);
    } finally {
      archive.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("discards incompatible legacy vectors instead of silently reusing them", async () => {
    recorder.callSizes = [];
    recorder.failAfterCall = Number.POSITIVE_INFINITY;
    const dataDir = mkdtempSync(join(tmpdir(), "mailcrawl-issue-39-legacy-drop-"));
    let archive = new Archive(join(dataDir, "archive.sqlite"));
    try {
      await archive.sync([message(0, "default native content")]);
      const chunk = archive.db.prepare("SELECT chunk_id, content_hash FROM chunks").get() as { chunk_id: string; content_hash: string };
      archive.db.exec("CREATE TABLE IF NOT EXISTS semantic_vectors (chunk_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', vector TEXT NOT NULL)");
      archive.db.prepare("INSERT INTO semantic_vectors (chunk_id, content_hash, model, vector) VALUES (?, ?, ?, ?)")
        .run(chunk.chunk_id, chunk.content_hash, LEGACY_EMBEDDING_MODEL, JSON.stringify(axisAt(7, 768)));
      archive.close();

      // Default provider (mock under test env): the legacy vectors are in a
      // different vector space and must be discarded, not reused.
      archive = new Archive(join(dataDir, "archive.sqlite"));
      const report = await archive.indexSemantic();
      expect(report).toMatchObject({ embedded: 1, reused: 0 });
      expect(archive.db.prepare("SELECT name FROM sqlite_master WHERE name = 'semantic_vectors'").get()).toBeUndefined();
    } finally {
      archive.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("issue #39: semantic search over the vector table", () => {
  it("applies account and mailbox filters at the vector layer", async () => {
    recorder.failAfterCall = Number.POSITIVE_INFINITY;
    const dataDir = mkdtempSync(join(tmpdir(), "mailcrawl-issue-39-filters-"));
    const archive = new Archive(join(dataDir, "archive.sqlite"));
    try {
      await archive.sync([
        message(0, "invoice reminder for payment", "work"),
        message(1, "invoice reminder for payment", "personal"),
      ]);
      await archive.indexSemantic();

      const all = await archive.searchSemantic("invoice");
      expect(all).toHaveLength(2);
      const workOnly = await archive.searchSemantic("invoice", { accountId: "work" });
      expect(workOnly).toHaveLength(1);
      expect(workOnly[0]?.accountId).toBe("work");
      expect(await archive.searchSemantic("invoice", { mailbox: "INBOX" })).toHaveLength(2);
      expect(await archive.searchSemantic("invoice", { mailbox: "Other" })).toHaveLength(0);
    } finally {
      archive.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("sweeps orphaned vector rows for chunks removed by later syncs", async () => {
    recorder.failAfterCall = Number.POSITIVE_INFINITY;
    const dataDir = mkdtempSync(join(tmpdir(), "mailcrawl-issue-39-sweep-"));
    const archive = new Archive(join(dataDir, "archive.sqlite"));
    try {
      await archive.sync([{ ...message(0, "original long enough content"), classifications: ["CATEGORY_SPAM"] }], { excludedCategories: [] });
      await archive.indexSemantic();
      // Excluding the spam message removes its chunks; the vector row is swept on the next index.
      await archive.sync([
        { ...message(0, "original long enough content"), classifications: ["CATEGORY_SPAM"] },
        message(1, "fresh content"),
      ], { excludedCategories: ["spam"] });
      const report = await archive.indexSemantic();
      expect(report.embedded).toBe(1);
      const summary = await archive.semanticSummary();
      expect(summary).toMatchObject({ status: "healthy", vectorCount: 1 });
    } finally {
      archive.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("summarizes semantic health from the store identity and queue", async () => {
    recorder.failAfterCall = Number.POSITIVE_INFINITY;
    const dataDir = mkdtempSync(join(tmpdir(), "mailcrawl-issue-39-summary-"));
    const archive = new Archive(join(dataDir, "archive.sqlite"));
    try {
      await archive.sync([message(0, "summary content")]);
      expect((await archive.semanticSummary()).status).toBe("never-completed");
      await archive.indexSemantic();
      expect((await archive.semanticSummary()).status).toBe("healthy");
      await archive.sync([message(1, "additional content")]);
      expect((await archive.semanticSummary()).status).toBe("interrupted");
      await archive.indexSemantic();
      expect((await archive.semanticSummary()).status).toBe("healthy");
    } finally {
      archive.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("returns no hits for an archive that was never indexed", async () => {
    recorder.failAfterCall = Number.POSITIVE_INFINITY;
    const dataDir = mkdtempSync(join(tmpdir(), "mailcrawl-issue-39-empty-"));
    const archive = new Archive(join(dataDir, "archive.sqlite"));
    try {
      await archive.sync([message(0, "unindexed content")]);
      expect(await archive.searchSemantic("unindexed")).toHaveLength(0);
    } finally {
      archive.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
