#!/usr/bin/env node
import { Command } from "commander";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Archive } from "../archive.js";
import { FixtureSource, HimalayaSource } from "../source.js";
import type { SearchFilters } from "../types.js";
import { redactDiagnostic } from "../redact.js";

const program = new Command();
program.name("mailcrawl").description("Local privacy-first email indexing CLI");
program.option("--data-dir <path>", "archive directory", process.env.MAILCRAWL_DATA_DIR || ".mailcrawl");

program
  .command("sync")
  .option("--source <source>", "fixture or himalaya", "himalaya")
  .option("--fixture <path>")
  .option("--account <name>")
  .option("--mailbox <name>", "mailbox name", "INBOX")
  .option("--backend <name>")
  .option("--page-size <n>", "envelopes per page", "1000")
  .option("--himalaya-config <path>")
  .option("--include-category <name>", "include a normally excluded category", collect, [])
  .option("--exclude-category <name>", "exclude a classification category", collect, [])
  .option("--json")
  .action(async (options: SyncOptions, command: Command) => {
    const dataDir = command.parent!.opts().dataDir as string;
    if (options.source !== "fixture" && options.source !== "himalaya") throw new Error(`unsupported source: ${options.source}`);
    if (options.source === "fixture" && !options.fixture) throw new Error("--fixture is required for fixture source");
    if (options.source === "himalaya" && !options.account) throw new Error("--account is required for himalaya source");
    await mkdir(dataDir, { recursive: true });
    const archive = new Archive(join(dataDir, "archive.sqlite"));
    try {
      const source = options.source === "fixture"
        ? fixtureSource(options)
        : himalayaSource(options);
      const excludedCategories = (options.excludeCategory.length ? options.excludeCategory : ["spam", "promotions"])
        .filter((category) => !options.includeCategory.includes(category));
      output(await archive.sync(await source.list(), { excludedCategories }), options.json);
    } finally {
      archive.close();
    }
  });

program
  .command("index")
  .alias("embed")
  .option("--json")
  .action(async (options: JsonOptions, command: Command) => {
    const dataDir = command.parent!.opts().dataDir as string;
    const archive = new Archive(join(dataDir, "archive.sqlite"));
    try { output({ ...await archive.indexSemanticGeneration(join(dataDir, "semantic")), embedder: "onnx-community/embeddinggemma-300m-ONNX" }, options.json); } finally { archive.close(); }
  });

for (const mode of ["bm25", "keyword", "semantic", "hybrid"] as const) {
  program
    .command(`search:${mode}`)
    .argument("<query>")
    .option("--account <id>")
    .option("--mailbox <name>")
    .option("--from <address>")
    .option("--to <address>")
    .option("--thread <id>")
    .option("--after <date>")
    .option("--before <date>")
    .option("--limit <n>", "result limit", "10")
    .option("--json")
    .action(async (query: string, options: SearchOptions, command: Command) => {
      const dataDir = command.parent!.opts().dataDir as string;
      const archive = new Archive(join(dataDir, "archive.sqlite"));
      try {
        const result = mode === "bm25" || mode === "keyword"
          ? await archive.searchBm25(query, filters(options), Number(options.limit))
          : mode === "hybrid"
            ? await archive.searchHybrid(query, filters(options), Number(options.limit))
            : await archive.searchSemantic(query, filters(options), Number(options.limit));
        output(result, options.json);
      } finally {
        archive.close();
      }
    });
}

program
  .command("search")
  .argument("<query>")
  .option("--mode <mode>", "fts, keyword, bm25, semantic, hybrid", "bm25")
  .option("--account <id>")
  .option("--mailbox <name>")
  .option("--from <address>")
  .option("--to <address>")
  .option("--thread <id>")
  .option("--after <date>")
  .option("--before <date>")
  .option("--limit <n>", "result limit", "10")
  .option("--json")
  .action(async (query: string, options: SearchOptions & { mode: string }, command: Command) => {
    const archive = new Archive(join(command.parent!.opts().dataDir, "archive.sqlite"));
    try {
      const filter = filters(options);
      const limit = Number(options.limit);
      const result = options.mode === "bm25" || options.mode === "fts" || options.mode === "keyword" ? await archive.searchBm25(query, filter, limit)
        : options.mode === "semantic" ? await archive.searchSemantic(query, filter, limit)
          : options.mode === "hybrid" ? await archive.searchHybrid(query, filter, limit)
            : (() => { throw new Error(`unsupported search mode: ${options.mode}`); })();
      output(result, options.json);
    } finally { archive.close(); }
  });

program
  .command("message")
  .command("get <messageId>")
  .option("--json")
  .action(async (messageId: string, options: JsonOptions, command: Command) => {
    const archive = new Archive(join(command.parent!.parent!.opts().dataDir, "archive.sqlite"));
    try { output(archive.getMessage(messageId) ?? null, options.json); } finally { archive.close(); }
  });

program
  .command("chunk-context")
  .argument("<chunkId>")
  .option("--json")
  .action(async (chunkId: string, options: JsonOptions, command: Command) => {
    const archive = new Archive(join(command.parent!.opts().dataDir, "archive.sqlite"));
    try { output(archive.getChunkContext(chunkId), options.json); } finally { archive.close(); }
  });

program
  .command("thread")
  .command("get <threadId>")
  .option("--from <address>")
  .option("--to <address>")
  .option("--after <date>")
  .option("--before <date>")
  .option("--json")
  .action(async (threadId: string, options: SearchOptions, command: Command) => {
    const archive = new Archive(join(command.parent!.parent!.opts().dataDir, "archive.sqlite"));
    try { output(archive.getThread(threadId, filters(options)), options.json); } finally { archive.close(); }
  });

program
  .command("thread-context")
  .argument("<threadId>")
  .option("--message <messageId>")
  .option("--json")
  .action(async (threadId: string, options: JsonOptions & { message?: string }, command: Command) => {
    const archive = new Archive(join(command.parent!.opts().dataDir, "archive.sqlite"));
    try { output(archive.getThreadContext(threadId, options.message), options.json); } finally { archive.close(); }
  });

program
  .command("doctor")
  .option("--json")
  .action(async (options: JsonOptions, command: Command) => {
    const dataDir = command.parent!.opts().dataDir as string;
    const archive = new Archive(join(dataDir, "archive.sqlite"));
    try {
      let semantic: unknown = "missing";
      try { semantic = semanticStatus(archive, archive.semanticGeneration(join(dataDir, "semantic"))); }
      catch (error) { semantic = redactDiagnostic({ status: semanticErrorStatus(error), error: error instanceof Error ? error.message : String(error) }); }
      const semanticCommitted = typeof semantic === "object" && semantic !== null && "generation" in semantic;
      output({
        name: "mailcrawl",
        archive: join(dataDir, "archive.sqlite"),
        archivePresent: existsSync(join(dataDir, "archive.sqlite")),
        fts: archive.status().fts,
        semantic,
        recommendation: semanticCommitted ? "semantic index is committed" : "run sync, then index before semantic search",
      }, options.json);
    } finally { archive.close(); }
  });

program
  .command("status")
  .option("--json")
  .action(async (options: JsonOptions, command: Command) => {
    const dataDir = command.parent!.opts().dataDir as string;
    const archivePath = join(dataDir, "archive.sqlite");
    if (!existsSync(archivePath)) {
      output({ name: "mailcrawl", archive: archivePath, archivePresent: false, messageCount: 0, chunkCount: 0, embeddingBacklog: 0, fts: { status: "missing", rows: 0 }, semantic: { status: "missing" } }, options.json);
      return;
    }
    const archive = new Archive(archivePath);
    try {
      let semantic: unknown = "missing";
      try { semantic = semanticStatus(archive, archive.semanticGeneration(join(dataDir, "semantic"))); }
      catch (error) { semantic = redactDiagnostic({ status: semanticErrorStatus(error), error: error instanceof Error ? error.message : String(error) }); }
      output({ name: "mailcrawl", archive: archivePath, archivePresent: true, ...archive.status(), semantic }, options.json);
    } finally { archive.close(); }
  });

program
  .command("repair")
  .option("--fts")
  .option("--semantic")
  .option("--all")
  .option("--json")
  .action(async (options: JsonOptions & { fts?: boolean; semantic?: boolean; all?: boolean }, command: Command) => {
    const dataDir = command.parent!.opts().dataDir as string;
    const archive = new Archive(join(dataDir, "archive.sqlite"));
    try {
      if (!options.fts && !options.semantic && !options.all) throw new Error("pass --fts, --semantic, or --all");
      const result: Record<string, unknown> = {};
      if (options.semantic || options.all) result.semantic = await archive.indexSemanticGeneration(join(dataDir, "semantic"));
      if (options.fts || options.all) result.fts = archive.repairFts();
      output(options.all ? result : result.fts ?? result.semantic, options.json);
    } finally { archive.close(); }
  });

const attachments = program.command("attachments");
attachments
  .command("list")
  .option("--message <messageId>")
  .option("--json")
  .action(async (options: JsonOptions & { message?: string }, command: Command) => {
    const archive = new Archive(join(command.parent!.parent!.opts().dataDir, "archive.sqlite"));
    try { output(archive.listAttachments(options.message), options.json); } finally { archive.close(); }
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify(redactDiagnostic({ error: message })));
  process.exitCode = 1;
});

interface JsonOptions { json?: boolean }
interface SyncOptions extends JsonOptions { source: string; fixture?: string; account?: string; mailbox: string; backend?: string; pageSize: string; himalayaConfig?: string; includeCategory: string[]; excludeCategory: string[] }
interface SearchOptions extends JsonOptions { account?: string; mailbox?: string; from?: string; to?: string; thread?: string; after?: string; before?: string; limit: string }
function filters(options: SearchOptions): SearchFilters {
  return { accountId: options.account, mailbox: options.mailbox, from: options.from, to: options.to, threadId: options.thread, after: options.after, before: options.before };
}
function fixtureSource(options: SyncOptions): FixtureSource {
  if (!options.fixture) throw new Error("--fixture is required for selected source");
  return new FixtureSource(options.fixture);
}
function himalayaSource(options: SyncOptions): HimalayaSource {
  if (!options.account) throw new Error("--account is required for selected source");
  return new HimalayaSource(options.account, options.mailbox, options.backend, Number(options.pageSize), options.himalayaConfig);
}
function semanticStatus(archive: Archive, semantic: { generation: string; archiveRevision: string; vectorCount: number }): object {
  return semantic.archiveRevision === archive.status().archiveRevision ? { ...semantic, status: "healthy" } : { ...semantic, status: "stale" };
}
function semanticErrorStatus(error: unknown): "missing" | "corrupt" {
  return error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : "corrupt";
}
function output(value: unknown, json?: boolean): void {
  if (json) console.log(JSON.stringify(value));
  else console.log(JSON.stringify(value, null, 2));
}
function collect(value: string, previous: string[]): string[] {
  return previous.concat(value.toLocaleLowerCase());
}
