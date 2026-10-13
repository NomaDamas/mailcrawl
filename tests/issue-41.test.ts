import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Archive } from "../src/archive.js";
import { FilesSource } from "../src/files-source.js";
import { scopedId } from "../src/util.js";

const run = promisify(execFile);
const FIXTURES = join("tests", "fixtures", "files");
const APPENDED = [
  "From carol@example.com Sun Aug 30 10:00:00 2026",
  "Message-ID: <appended-1@example.com>",
  "Date: Sun, 30 Aug 2026 10:00:00 +0000",
  "From: carol@example.com",
  "To: alice@example.com",
  "Subject: Offsite logistics",
  "",
  "The offsite venue is confirmed for September.",
  "",
].join("\n");

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function copyFixtures(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mailcrawl-issue-41-"));
  scratch.push(dir);
  const root = join(dir, "backup");
  await cp(FIXTURES, root, { recursive: true });
  return root;
}

async function syncFiles(archive: Archive, paths: string[], account = "takeout") {
  const source = new FilesSource({ paths, account, previous: (rootKey) => archive.sourceFileStates(rootKey) });
  const result = await source.collect();
  const report = await archive.sync(result.messages, { files: result.snapshot });
  return { result, report };
}

const messageKey = (mailbox: string, messageId: string) => scopedId("takeout", mailbox, messageId);

describe("issue 41: files source", () => {
  it("indexes .eml files and an mbox, reporting malformed messages without aborting", async () => {
    const root = await copyFixtures();
    const archive = new Archive();
    const { result, report } = await syncFiles(archive, [root]);

    // 2 .eml + 3 mbox messages indexed; the promotions message is excluded by default.
    expect(report).toMatchObject({ added: 5, deleted: 0, excluded: 1, excludedByReason: { promotions: 1 } });
    expect(result.failures.map((failure) => failure.providerKey).sort()).toEqual(["backup/eml/malformed.eml", "backup/takeout.mbox#5"]);
    expect(JSON.stringify(result.failures)).not.toContain(dirname(root));

    const budget = archive.getMessage(messageKey("takeout", "<thread-1@example.com>"));
    // mboxrd: one level of >From quoting is undone (the remaining `>` line is quoted text).
    expect(budget?.latestText).toContain("draft.\nFrom the finance team, with thanks.");
    expect(budget?.quotedText).toBe(">From line kept with one quote.");
    expect(budget?.labels).toEqual(["Inbox", "Important", "Work, Finance"]);
    // No Message-ID and no Date header: identity is the content hash, date the UTC From_ line.
    const [note] = archive.db.prepare("SELECT date FROM messages WHERE subject = 'Note without identifier'").all() as { date: string }[];
    expect(note.date).toBe("2026-08-29T07:30:00.000Z");
    expect(archive.listAttachments(messageKey("eml", "<renewal-1@example.com>"))).toEqual([
      expect.objectContaining({ name: "terms.txt", extractedText: expect.stringContaining("twelve months") }),
    ]);
    archive.close();
  });

  it("makes an unchanged re-sync a no-op that re-reports stored failures", async () => {
    const root = await copyFixtures();
    const archive = new Archive();
    await syncFiles(archive, [root]);
    const revision = archive.status().archiveRevision;

    const { result, report } = await syncFiles(archive, [root]);
    expect(result.messages).toEqual([]);
    expect(result.snapshot.files.every((file) => !file.changed)).toBe(true);
    expect(report).toMatchObject({ added: 0, updated: 0, deleted: 0, archiveRevision: revision });
    expect(result.failures).toHaveLength(2);
    archive.close();
  });

  it("indexes exactly an appended mbox message and deletes it when removed", async () => {
    const root = await copyFixtures();
    const mbox = join(root, "takeout.mbox");
    const original = await readFile(mbox);
    const archive = new Archive();
    await syncFiles(archive, [root]);

    await appendFile(mbox, APPENDED);
    const appended = await syncFiles(archive, [root]);
    expect(appended.result.snapshot.files.filter((file) => file.changed).map((file) => file.relPath)).toEqual(["takeout.mbox"]);
    expect(appended.report).toMatchObject({ added: 1, updated: 0, deleted: 0 });
    expect(archive.getMessage(messageKey("takeout", "<appended-1@example.com>"))?.subject).toBe("Offsite logistics");

    await writeFile(mbox, original);
    const removed = await syncFiles(archive, [root]);
    expect(removed.report).toMatchObject({ added: 0, deleted: 1 });
    expect(archive.getMessage(messageKey("takeout", "<appended-1@example.com>"))).toBeUndefined();
    expect(archive.status().messageCount).toBe(5);
    archive.close();
  });

  it("deletes a message only when the last file holding it disappears", async () => {
    const root = await copyFixtures();
    await cp(join(root, "eml", "renewal.eml"), join(root, "eml", "renewal-copy.eml"));
    const archive = new Archive();
    const first = await syncFiles(archive, [root]);
    expect(first.result.duplicates).toEqual(["backup/eml/renewal.eml"]);
    const renewal = messageKey("eml", "<renewal-1@example.com>");

    await rm(join(root, "eml", "renewal-copy.eml"));
    expect((await syncFiles(archive, [root])).report.deleted).toBe(0);
    expect(archive.getMessage(renewal)).toBeDefined();

    await rm(join(root, "eml", "renewal.eml"));
    expect((await syncFiles(archive, [root])).report.deleted).toBe(1);
    expect(archive.getMessage(renewal)).toBeUndefined();
    archive.close();
  });

  it("keeps an indexed mbox message whose entry becomes unparseable", async () => {
    const root = await copyFixtures();
    const mbox = join(root, "takeout.mbox");
    const archive = new Archive();
    await syncFiles(archive, [root]);

    const text = await readFile(mbox, "utf8");
    const broken = text.replace(/Message-ID: <thread-2@example\.com>[\s\S]*?\r?\n\r?\n/, "garbage instead of headers\n\n");
    await writeFile(mbox, broken);
    const { result, report } = await syncFiles(archive, [root]);
    expect(report.deleted).toBe(0);
    expect(result.failures.map((failure) => failure.providerKey)).toContain("backup/takeout.mbox#2");
    expect(archive.getMessage(messageKey("takeout", "<thread-2@example.com>"))).toBeDefined();
    archive.close();
  });

  it("makes a CJK message searchable through BM25 and hybrid search", async () => {
    const root = await copyFixtures();
    const archive = new Archive();
    await syncFiles(archive, [root]);
    await archive.indexSemantic();
    const korean = messageKey("eml", "<korean-1@example.com>");

    expect((await archive.searchBm25("계약 갱신")).map((hit) => hit.messageId)).toContain(korean);
    const hybrid = await archive.searchHybrid("계약 갱신");
    expect(hybrid[0]).toMatchObject({ messageId: korean, mode: "hybrid" });
    archive.close();
  });

  it("syncs and searches through the CLI with no himalaya on PATH", async () => {
    const root = await copyFixtures();
    const dataDir = join(dirname(root), "data");
    // Only node's own directory: `himalaya` cannot be resolved.
    const environment = { ...process.env, PATH: dirname(process.execPath), MAILCRAWL_EMBEDDER: "mock", MAILCRAWL_LEXICAL_MODE: "mock" };
    const cli = [join("dist", "cli", "index.js"), "--data-dir", dataDir];

    const first = await run(process.execPath, [...cli, "sync", "--source", "files", "--path", root, "--json"], { env: environment });
    const report = JSON.parse(first.stdout) as { account: string; added: number; files: number; filesRead: number; failures: Array<{ providerKey: string }> };
    expect(report).toMatchObject({ account: "backup", added: 5, files: 4, filesRead: 4 });
    expect(first.stdout).not.toContain(dirname(root));

    const second = await run(process.execPath, [...cli, "sync", "--source", "files", "--path", root, "--json"], { env: environment });
    expect(JSON.parse(second.stdout)).toMatchObject({ added: 0, updated: 0, deleted: 0, filesRead: 0 });

    await run(process.execPath, [...cli, "index", "--json"], { env: environment });
    const search = await run(process.execPath, [...cli, "search", "--mode", "hybrid", "--json", "계약 갱신"], { env: environment });
    expect(JSON.parse(search.stdout)[0]).toMatchObject({ subject: "계약 갱신 조건 안내", accountId: "backup", mailbox: "eml" });

    await expect(run(process.execPath, [...cli, "sync", "--source", "files", "--path", join(root, "missing"), "--json"], { env: environment }))
      .rejects.toMatchObject({ code: 1, stderr: expect.not.stringContaining(dirname(root)) });
  }, 30_000);
});
