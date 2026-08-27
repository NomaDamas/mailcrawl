import { EmbeddingModel, FlagEmbedding } from "fastembed";

export interface Embedder {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
}

class FastEmbedder implements Embedder {
  private constructor(private readonly model: FlagEmbedding) {}

  static async create(): Promise<FastEmbedder> {
    const model = await FlagEmbedding.init({
      model: EmbeddingModel.MLE5Large,
      showDownloadProgress: false,
    });
    return new FastEmbedder(model);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const result: number[][] = [];
    for await (const batch of this.model.passageEmbed(texts, 32)) result.push(...batch);
    return result;
  }

  embedQuery(query: string): Promise<number[]> {
    return this.model.queryEmbed(query.trim());
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
  return FastEmbedder.create();
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
