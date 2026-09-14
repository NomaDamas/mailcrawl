import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type { LoopbackHttpConfig } from "./types.js";

export interface Embedder {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
}

const EMBEDDING_MODEL = "onnx-community/embeddinggemma-300m-ONNX";
const QUERY_PREFIX = "task: search result | query: ";
const DOCUMENT_PREFIX = "title: none | text: ";

class EmbeddingGemma implements Embedder {
  private constructor(private readonly model: FeatureExtractionPipeline) {}

  static async create(): Promise<EmbeddingGemma> {
    const model = await pipeline("feature-extraction", EMBEDDING_MODEL, {
      dtype: "q8",
      device: "cpu",
    });
    return new EmbeddingGemma(model);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embed(texts.map((text) => DOCUMENT_PREFIX + text));
  }

  async embedQuery(query: string): Promise<number[]> {
    return (await this.embed([QUERY_PREFIX + query.trim()]))[0];
  }

  private async embed(texts: string[]): Promise<number[][]> {
    const output = await this.model(texts, { pooling: "mean", normalize: true });
    return output.tolist() as number[][];
  }
}

class TestEmbedder implements Embedder {
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map(hashVector);
  }
  async embedQuery(query: string): Promise<number[]> {
    return hashVector(query);
  }
}

class LoopbackHttpEmbedder implements Embedder {
  constructor(private readonly config: LoopbackHttpConfig) {
    const url = new URL(config.url);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
      throw new Error("loopback HTTP embedding URL is required");
    }
    if (!Number.isInteger(config.dimension) || config.dimension <= 0) throw new Error("embedding dimension must be positive");
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.request(texts.map((text) => (this.config.passagePrefix ?? "") + text));
  }

  async embedQuery(query: string): Promise<number[]> {
    return (await this.request([(this.config.queryPrefix ?? "") + query.trim()]))[0];
  }

  private async request(texts: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000);
    try {
      const response = await fetch(this.config.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.config.model, texts }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`embedding provider returned HTTP ${response.status}`);
      const payload = await response.json() as { embeddings?: unknown };
      if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== texts.length) throw new Error("embedding provider returned invalid embeddings");
      const vectors = payload.embeddings as number[][];
      if (vectors.some((vector) => !Array.isArray(vector) || vector.length !== this.config.dimension || vector.some((value) => typeof value !== "number"))) {
        throw new Error("embedding provider returned invalid vector dimensions");
      }
      return vectors;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function createEmbedder(config?: LoopbackHttpConfig): Promise<Embedder> {
  if (config?.provider === "loopback-http") return new LoopbackHttpEmbedder(config);
  if (process.env.MAILCRAWL_EMBEDDER === "mock" || process.env.NODE_ENV === "test") return new TestEmbedder();
  return EmbeddingGemma.create();
}

export function embeddingModelName(config?: LoopbackHttpConfig): string {
  return config
    ? `loopback-http:${config.model}:${config.dimension}:${config.url}:${config.queryPrefix ?? ""}:${config.passagePrefix ?? ""}:${config.timeoutMs ?? 30_000}`
    : EMBEDDING_MODEL;
}

export function loopbackConfigFromEnvironment(): LoopbackHttpConfig | undefined {
  if (process.env.MAILCRAWL_EMBEDDER_PROVIDER !== "loopback-http") return undefined;
  const url = process.env.MAILCRAWL_EMBED_URL;
  const model = process.env.MAILCRAWL_EMBED_MODEL;
  const dimension = Number(process.env.MAILCRAWL_EMBED_DIM);
  if (!url || !model || !Number.isInteger(dimension)) throw new Error("MAILCRAWL_EMBED_URL, MAILCRAWL_EMBED_MODEL, and MAILCRAWL_EMBED_DIM are required");
  return {
    provider: "loopback-http", url, model, dimension,
    queryPrefix: process.env.MAILCRAWL_QUERY_PREFIX,
    passagePrefix: process.env.MAILCRAWL_PASSAGE_PREFIX,
    timeoutMs: process.env.MAILCRAWL_EMBED_TIMEOUT ? Number(process.env.MAILCRAWL_EMBED_TIMEOUT) : undefined,
  };
}

function hashVector(text: string): number[] {
  const vector = new Array<number>(128).fill(0);
  for (const [index, term] of text.normalize("NFKC").toLocaleLowerCase().split(/\s+/u).entries()) {
    let hash = 2166136261;
    for (const char of term) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
    vector[Math.abs(hash + index) % vector.length] += 1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}
