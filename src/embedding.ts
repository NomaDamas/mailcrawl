/**
 * Embedding providers (issue #39).
 *
 * Default: an in-process native embedder (`native:Qwen/Qwen3-Embedding-0.6B`,
 * 1024-d) running on ONNX Runtime's native binding — WebGPU (Metal on Apple
 * Silicon) with CPU fallback, batched, no HTTP sidecar — matching the MinSync
 * native profile. EmbeddingGemma remains as the `legacy-onnx` opt-in profile
 * and `loopback-http` stays as the #31 opt-in override.
 */
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type { EmbedderConfig, EmbedderIdentity, LegacyOnnxConfig, LoopbackHttpConfig, NativeDtype, NativeEmbedderConfig } from "./types.js";

export interface Embedder {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
}

/** Registry of native embedding models (MinSync-aligned ids). */
interface NativeModelProfile {
  /** Hugging Face repo containing the ONNX export. */
  repo: string;
  dimension: number;
  pooling: "mean" | "last_token";
}

const NATIVE_MODELS: Record<string, NativeModelProfile> = {
  "Qwen/Qwen3-Embedding-0.6B": {
    repo: "onnx-community/Qwen3-Embedding-0.6B-ONNX",
    dimension: 1024,
    pooling: "last_token",
  },
};

export const DEFAULT_NATIVE_MODEL = "Qwen/Qwen3-Embedding-0.6B";
export const DEFAULT_NATIVE_BATCH_SIZE = 4;
export const RUNTIME_BUILD_NATIVE = "mailcrawl-native";
export const RUNTIME_BUILD_LEGACY = "mailcrawl-legacy-onnx";
export const RUNTIME_BUILD_LOOPBACK = "mailcrawl-loopback-http";
export const RUNTIME_BUILD_MOCK = "mailcrawl-mock";

const LEGACY_MODEL = "onnx-community/embeddinggemma-300m-ONNX";
export const LEGACY_EMBEDDING_MODEL = LEGACY_MODEL;
const LEGACY_QUERY_PREFIX = "task: search result | query: ";
const LEGACY_DOCUMENT_PREFIX = "title: none | text: ";
const LEGACY_DIMENSION = 768;
const DEFAULT_BATCH_SIZE = 32;

export function nativeModelProfile(model: string): NativeModelProfile {
  const id = model.startsWith("native:") ? model.slice("native:".length) : model;
  const profile = NATIVE_MODELS[id];
  if (!profile) {
    throw new Error(`unknown native embedding model: ${model} (supported: ${Object.keys(NATIVE_MODELS).map((name) => `native:${name}`).join(", ")})`);
  }
  return profile;
}

export function defaultNativeConfig(overrides: Partial<Omit<NativeEmbedderConfig, "provider" | "dimension">> = {}): NativeEmbedderConfig {
  const model = overrides.model ?? DEFAULT_NATIVE_MODEL;
  return {
    provider: "native",
    model,
    dimension: nativeModelProfile(model).dimension,
    device: overrides.device ?? "auto",
    dtype: overrides.dtype ?? "q4f16",
    batchSize: overrides.batchSize ?? DEFAULT_NATIVE_BATCH_SIZE,
    queryPrefix: overrides.queryPrefix,
    passagePrefix: overrides.passagePrefix,
  };
}

/**
 * In-process native embedder. Loads the ONNX model through the native
 * onnxruntime-node binding (no HTTP sidecar), resolving `device: "auto"` to
 * WebGPU first — Metal-backed on Apple Silicon — and falling back to CPU on
 * failure. `embedDocuments` always chunks its input by `batchSize` so no
 * caller can hand the runtime an unbounded batch (issue #37).
 */
class NativeEmbedder implements Embedder {
  private model?: FeatureExtractionPipeline;
  private modelDevice?: "webgpu" | "cpu";

  private constructor(private readonly config: NativeEmbedderConfig, private readonly profile: NativeModelProfile) {}

  static async create(config: NativeEmbedderConfig): Promise<NativeEmbedder> {
    if (!Number.isInteger(config.batchSize) || config.batchSize <= 0) throw new Error("native embedder batch_size must be a positive integer");
    return new NativeEmbedder(config, nativeModelProfile(config.model));
  }

  /** Device actually in use after the model loaded ("webgpu" | "cpu"), for diagnostics. */
  get resolvedDevice(): "webgpu" | "cpu" | undefined {
    return this.modelDevice;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const model = await this.load();
    const prefix = this.config.passagePrefix ?? "";
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += this.config.batchSize) {
      const batch = texts.slice(offset, offset + this.config.batchSize).map((text) => prefix + text);
      const output = await model(batch, { pooling: this.profile.pooling, normalize: true });
      const batchVectors = output.tolist() as number[][];
      if (batchVectors.length !== batch.length) throw new Error("native embedder returned an unexpected embedding count");
      for (const vector of batchVectors) this.validateDimension(vector);
      vectors.push(...batchVectors);
    }
    return vectors;
  }

  async embedQuery(query: string): Promise<number[]> {
    const model = await this.load();
    const text = (this.config.queryPrefix ?? "") + query.trim();
    const output = await model([text], { pooling: this.profile.pooling, normalize: true });
    const vector = (output.tolist() as number[][])[0];
    this.validateDimension(vector);
    return vector;
  }

  private async load(): Promise<FeatureExtractionPipeline> {
    if (this.model) return this.model;
    const wanted = this.config.device === "auto" ? "webgpu" : this.config.device;
    try {
      this.model = await this.buildSession(wanted);
      this.modelDevice = wanted;
    } catch (error) {
      if (this.config.device !== "auto") throw error;
      this.model = await this.buildSession("cpu");
      this.modelDevice = "cpu";
    }
    return this.model;
  }

  private buildSession(device: "webgpu" | "cpu"): Promise<FeatureExtractionPipeline> {
    const dtype = this.config.dtype ?? (device === "webgpu" ? "q4f16" : "q8");
    return pipeline("feature-extraction", this.profile.repo, { device, dtype });
  }

  private validateDimension(vector: number[]): void {
    if (vector.length !== this.profile.dimension) {
      throw new Error(`native embedder returned dimension ${vector.length}, expected ${this.profile.dimension}`);
    }
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new Error("native embedder returned non-finite values; try --device cpu or a different --dtype");
    }
  }
}

/** Legacy opt-in profile: EmbeddingGemma via Transformers.js on CPU (pre-#39 default). */
class EmbeddingGemma implements Embedder {
  private constructor(private readonly model: FeatureExtractionPipeline) {}

  static async create(): Promise<EmbeddingGemma> {
    const model = await pipeline("feature-extraction", LEGACY_MODEL, {
      dtype: "q8",
      device: "cpu",
    });
    return new EmbeddingGemma(model);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embed(texts.map((text) => LEGACY_DOCUMENT_PREFIX + text));
  }

  async embedQuery(query: string): Promise<number[]> {
    return (await this.embed([LEGACY_QUERY_PREFIX + query.trim()]))[0];
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
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(hostname)) {
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

export async function createEmbedder(config?: EmbedderConfig): Promise<Embedder> {
  if (config?.provider === "loopback-http") return new LoopbackHttpEmbedder(config);
  if (config?.provider === "legacy-onnx") return EmbeddingGemma.create();
  if (config?.provider === "native") return NativeEmbedder.create(config);
  if (config?.provider === "mock") return new TestEmbedder();
  if (process.env.MAILCRAWL_EMBEDDER === "mock" || process.env.NODE_ENV === "test") return new TestEmbedder();
  return NativeEmbedder.create(defaultNativeConfig());
}

/**
 * Embedder identity for persistence (issue #39: identity is data). Pure and
 * synchronous: never loads the model.
 */
export function embedderIdentity(config?: EmbedderConfig): EmbedderIdentity {
  switch (config?.provider) {
    case "loopback-http":
      return {
        provider: "loopback-http",
        model: config.model,
        dimension: config.dimension,
        queryPrefix: config.queryPrefix,
        passagePrefix: config.passagePrefix,
        runtimeBuild: RUNTIME_BUILD_LOOPBACK,
      };
    case "legacy-onnx":
      return {
        provider: "legacy-onnx",
        model: LEGACY_MODEL,
        dimension: LEGACY_DIMENSION,
        queryPrefix: LEGACY_QUERY_PREFIX,
        passagePrefix: LEGACY_DOCUMENT_PREFIX,
        runtimeBuild: RUNTIME_BUILD_LEGACY,
      };
    case "native": {
      const profile = nativeModelProfile(config.model);
      return {
        provider: "native",
        model: config.model.startsWith("native:") ? config.model : `native:${config.model}`,
        dimension: profile.dimension,
        queryPrefix: config.queryPrefix,
        passagePrefix: config.passagePrefix,
        runtimeBuild: RUNTIME_BUILD_NATIVE,
      };
    }
    case "mock":
      return { provider: "mock", model: "hash-128", dimension: 128, runtimeBuild: RUNTIME_BUILD_MOCK };
    default:
      if (process.env.MAILCRAWL_EMBEDDER === "mock" || process.env.NODE_ENV === "test") {
        return { provider: "mock", model: "hash-128", dimension: 128, runtimeBuild: RUNTIME_BUILD_MOCK };
      }
      return {
        provider: "native",
        model: `native:${DEFAULT_NATIVE_MODEL}`,
        dimension: nativeModelProfile(DEFAULT_NATIVE_MODEL).dimension,
        runtimeBuild: RUNTIME_BUILD_NATIVE,
      };
  }
}

/** Human-readable one-line identity (kept stable for CLI output and tests). */
export function embeddingModelName(config?: EmbedderConfig): string {
  if (config?.provider === "loopback-http") {
    return `loopback-http:${config.model}:${config.dimension}:${config.url}:${config.queryPrefix ?? ""}:${config.passagePrefix ?? ""}:${config.timeoutMs ?? 30_000}`;
  }
  return embedderIdentityLabel(embedderIdentity(config));
}

/** `provider:model:dimension`, without doubling the native model id prefix. */
export function embedderIdentityLabel(identity: EmbedderIdentity): string {
  const model = identity.model.startsWith("native:") ? identity.model.slice("native:".length) : identity.model;
  return `${identity.provider}:${model}:${identity.dimension}`;
}

/** Batch size for the index loop; native defaults to the MinSync-style 4, others to 32. */
export function embeddingBatchSize(config?: EmbedderConfig): number {
  if (config?.provider === "native") return config.batchSize ?? DEFAULT_NATIVE_BATCH_SIZE;
  return config?.batchSize ?? DEFAULT_BATCH_SIZE;
}

/** Builds the embedder config from the environment (no flags needed for the default native path). */
export function embedderConfigFromEnvironment(): EmbedderConfig | undefined {
  if (process.env.MAILCRAWL_EMBEDDER === "mock") return { provider: "mock" };
  const provider = process.env.MAILCRAWL_EMBEDDER_PROVIDER;
  if (provider === "loopback-http") {
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
  if (provider === "legacy-onnx") {
    return { provider: "legacy-onnx", batchSize: batchFromEnvironment() };
  }
  if (provider !== undefined && provider !== "native") throw new Error(`unsupported MAILCRAWL_EMBEDDER_PROVIDER: ${provider}`);
  const model = process.env.MAILCRAWL_NATIVE_MODEL ?? DEFAULT_NATIVE_MODEL;
  return {
    provider: "native",
    model,
    dimension: nativeModelProfile(model).dimension,
    device: parseNativeDevice(process.env.MAILCRAWL_NATIVE_DEVICE ?? "auto"),
    dtype: parseNativeDtype(process.env.MAILCRAWL_NATIVE_DTYPE ?? "q4f16"),
    batchSize: batchFromEnvironment() ?? DEFAULT_NATIVE_BATCH_SIZE,
    queryPrefix: process.env.MAILCRAWL_QUERY_PREFIX,
    passagePrefix: process.env.MAILCRAWL_PASSAGE_PREFIX,
  };
}

function batchFromEnvironment(): number | undefined {
  const value = process.env.MAILCRAWL_EMBED_BATCH_SIZE;
  if (value === undefined || value === "") return undefined;
  const size = Number(value);
  if (!Number.isInteger(size) || size <= 0) throw new Error("MAILCRAWL_EMBED_BATCH_SIZE must be a positive integer");
  return size;
}

export function parseNativeDevice(value: string): NativeEmbedderConfig["device"] {
  // "metal" is accepted as a MinSync-vocabulary alias for the WebGPU device,
  // which ONNX Runtime backs with Metal on Apple Silicon.
  if (value === "metal") return "webgpu";
  if (value === "auto" || value === "cpu" || value === "webgpu") return value;
  throw new Error(`invalid native device '${value}': expected auto, cpu, webgpu, or metal`);
}

export function parseNativeDtype(value: string): NativeDtype {
  const allowed: NativeDtype[] = ["fp32", "fp16", "q8", "int8", "q4", "q4f16", "uint8"];
  if ((allowed as string[]).includes(value)) return value as NativeDtype;
  throw new Error(`invalid native dtype '${value}': expected ${allowed.join(", ")}`);
}

/** Legacy config helper used by tests: the pre-#39 default profile. */
export function legacyEmbedderConfig(): LegacyOnnxConfig {
  return { provider: "legacy-onnx" };
}

/**
 * Identity of vectors persisted by pre-#39 mailcrawl (JSON-in-SQLite),
 * recoverable only when the legacy EmbeddingGemma profile is explicitly active.
 * Returns undefined for any other stored model, forcing a rebuild.
 */
export function legacyEmbedderIdentity(model: string, dimension: number): EmbedderIdentity | undefined {
  if (model !== LEGACY_MODEL) return undefined;
  return {
    provider: "legacy-onnx",
    model: LEGACY_MODEL,
    dimension,
    queryPrefix: LEGACY_QUERY_PREFIX,
    passagePrefix: LEGACY_DOCUMENT_PREFIX,
    runtimeBuild: RUNTIME_BUILD_LEGACY,
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
