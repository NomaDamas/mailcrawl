import { describe, expect, it } from "vitest";
import { defaultInlConfig, defaultNativeConfig, embedderIdentity } from "../src/embedding.js";
import { sameEmbedder } from "../src/semantic-store.js";

const MODEL = "Qwen/Qwen3-Embedding-0.6B";
const INSTRUCT = "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:";

/** What AutoRAG puts in the environment for a running inl daemon: the OpenAI wire, a loopback URL, the model. */
const autoragInjected = (port: number, queryPrefix?: string) => ({
  provider: "openai" as const, url: `http://127.0.0.1:${port}`, model: MODEL, dimension: 1024, queryPrefix,
});

describe("embedder identity follows the vector space, not the way it is reached", () => {
  it("is one identity for the inl provider, the default config, and AutoRAG's loopback openai endpoint", () => {
    const viaInl = embedderIdentity({ provider: "inl", model: MODEL });
    const viaAuto = embedderIdentity(defaultInlConfig());
    const viaAutorag = embedderIdentity(autoragInjected(51490, INSTRUCT));
    expect(sameEmbedder(viaInl, viaAuto)).toBe(true);
    expect(sameEmbedder(viaInl, viaAutorag)).toBe(true);
    // The daemon's port changes on every start; it is not part of the identity.
    expect(sameEmbedder(viaAutorag, embedderIdentity(autoragInjected(60204, INSTRUCT)))).toBe(true);
  });

  it("keeps the in-process ONNX embedder apart: its vectors are a different space", () => {
    const native = embedderIdentity({ ...defaultNativeConfig(), provider: "native" });
    expect(sameEmbedder(native, embedderIdentity({ provider: "inl", model: MODEL }))).toBe(false);
    expect(sameEmbedder(native, embedderIdentity(autoragInjected(51490)))).toBe(false);
  });

  it("ignores the query prefix: it changes queries, never stored vectors", () => {
    expect(sameEmbedder(embedderIdentity(autoragInjected(1, INSTRUCT)), embedderIdentity(autoragInjected(1)))).toBe(true);
    expect(sameEmbedder(embedderIdentity({ provider: "inl", model: MODEL, queryPrefix: "q: " }), embedderIdentity({ provider: "inl", model: MODEL }))).toBe(true);
  });

  it("still rebuilds when the passage prefix changes, since that is embedded into every vector", () => {
    expect(sameEmbedder(
      embedderIdentity({ provider: "inl", model: MODEL, passagePrefix: "p: " }),
      embedderIdentity({ provider: "inl", model: MODEL }),
    )).toBe(false);
  });

  it("does not fold other models or remote endpoints into the inl identity", () => {
    const inl = embedderIdentity({ provider: "inl", model: MODEL });
    expect(sameEmbedder(inl, embedderIdentity({ provider: "openai", url: "http://127.0.0.1:1", model: "other/model", dimension: 1024 }))).toBe(false);
    expect(sameEmbedder(inl, embedderIdentity({ provider: "openai", url: "https://api.example.com", model: MODEL, dimension: 1024, allowRemote: true }))).toBe(false);
    expect(sameEmbedder(inl, embedderIdentity({ provider: "tei", url: "http://127.0.0.1:1", model: MODEL, dimension: 1024 }))).toBe(false);
  });
});
