import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

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

export async function createEmbedder(): Promise<Embedder> {
  if (process.env.MAILCRAWL_EMBEDDER === "mock" || process.env.NODE_ENV === "test") return new TestEmbedder();
  return EmbeddingGemma.create();
}

export function embeddingModelName(): string {
  return EMBEDDING_MODEL;
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
