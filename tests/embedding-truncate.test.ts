import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createEmbedder } from "../src/embedding.js";
import type { ServerEmbedderConfig } from "../src/types.js";

interface RequestBody { model?: string; inputs?: string[]; input?: string[]; truncate?: boolean }

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()!;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

/** Serves `reply(body)` for every POST and records each request body. */
async function serve(reply: (body: RequestBody) => unknown): Promise<{ url: string; bodies: RequestBody[] }> {
  const bodies: RequestBody[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RequestBody;
    bodies.push(body);
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(reply(body)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return { url: `http://127.0.0.1:${address.port}`, bodies };
}

const teiReply = (body: RequestBody) => (body.inputs ?? []).map(() => [1, 2, 3]);
const openaiReply = (body: RequestBody) => ({
  object: "list",
  model: body.model,
  data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 2, 3] })),
});

describe("opt-in context truncation for server embedders", () => {
  it("sends truncate: true to a tei server only when configured", async () => {
    const server = await serve(teiReply);
    const config: ServerEmbedderConfig = { provider: "tei", url: server.url, model: "m", dimension: 3 };
    await (await createEmbedder(config)).embedDocuments(["over context"]);
    await (await createEmbedder({ ...config, truncate: true })).embedDocuments(["over context"]);
    expect(server.bodies[0]).not.toHaveProperty("truncate");
    expect(server.bodies[1]).toMatchObject({ truncate: true });
  });

  it("sends truncate: true to an openai server only when configured", async () => {
    const server = await serve(openaiReply);
    const config: ServerEmbedderConfig = { provider: "openai", url: server.url, model: "m", dimension: 3 };
    await (await createEmbedder(config)).embedDocuments(["over context"]);
    await (await createEmbedder({ ...config, truncate: true })).embedDocuments(["over context"]);
    expect(server.bodies[0]).not.toHaveProperty("truncate");
    expect(server.bodies[1]).toMatchObject({ truncate: true });
    expect(server.bodies[1].input).toEqual(["over context"]);
  });
});
