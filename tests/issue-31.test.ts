import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "../src/archive.js";
import { createEmbedder, embeddingModelName } from "../src/embedding.js";

describe("issue #31 loopback HTTP embedding provider", () => {
  it("accepts loopback URLs and rejects remote URLs", async () => {
    for (const url of ["http://127.0.0.1:4318/embed", "http://localhost:4318/embed", "http://[::1]:4318/embed"]) {
      await expect(createEmbedder({
        provider: "loopback-http",
        url,
        model: "test-model",
        dimension: 3,
      })).resolves.toBeDefined();
    }
    await expect(createEmbedder({
      provider: "loopback-http",
      url: "https://example.com/embed",
      model: "test-model",
      dimension: 3,
    })).rejects.toThrow(/loopback/i);
  });

  it("sends only prefixed text and returns the configured vectors", async () => {
    const requests: unknown[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ embeddings: [[1, 2, 3]] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    try {
      const embedder = await createEmbedder({
        provider: "loopback-http",
        url: `http://127.0.0.1:${address.port}/embed`,
        model: "test-model",
        dimension: 3,
        passagePrefix: "passage: ",
      });
      await expect(embedder.embedDocuments(["secret body"])).resolves.toEqual([[1, 2, 3]]);
      expect(requests).toEqual([{ model: "test-model", texts: ["passage: secret body"] }]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("includes provider identity in the model name", async () => {
    expect(embeddingModelName({
      provider: "loopback-http",
      url: "http://localhost:4318/embed",
      model: "shared-model",
      dimension: 3,
    })).toBe("loopback-http:shared-model:3:http://localhost:4318/embed:::" + 30_000);
  });

  it("records the configured provider identity next to the vector table even when embedding fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "mailcrawl-issue-31-"));
    const archive = new Archive(join(root, "archive.sqlite"), {
      provider: "loopback-http",
      url: "http://localhost:4318/embed",
      model: "shared-model",
      dimension: 3,
    });
    try {
      await archive.sync([{
        accountId: "a", mailbox: "INBOX", providerKey: "p", messageId: "m",
        threadId: "t", subject: "Manifest", from: "a@example.com", to: [], cc: [],
        date: "2026-08-26T00:00:00Z", text: "manifest body",
      }]);
      // The configured endpoint is intentionally unreachable; the persisted
      // embedder identity must still record the provider, and no batch may commit.
      await expect(archive.indexSemantic()).rejects.toThrow();
      const identity = JSON.parse(readFileSync(join(root, "semantic.identity.json"), "utf8"));
      expect(identity).toMatchObject({ provider: "loopback-http", model: "shared-model", dimension: 3 });
      expect(archive.db.prepare("SELECT state FROM embedding_queue").all()).toEqual([{ state: "pending" }]);
    } finally {
      archive.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
