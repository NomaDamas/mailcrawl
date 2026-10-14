import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { appendFile, chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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

  it("keeps an indexed mbox message whose entry becomes unparseable, across later appends", async () => {
    const root = await copyFixtures();
    const mbox = join(root, "takeout.mbox");
    const archive = new Archive();
    await syncFiles(archive, [root]);
    const reply = messageKey("takeout", "<thread-2@example.com>");

    const text = await readFile(mbox, "utf8");
    const broken = text.replace(/Message-ID: <thread-2@example\.com>[\s\S]*?\r?\n\r?\n/, "garbage instead of headers\n\n");
    await writeFile(mbox, broken);
    const { result, report } = await syncFiles(archive, [root]);
    expect(report.deleted).toBe(0);
    expect(result.failures.map((failure) => failure.providerKey)).toContain("backup/takeout.mbox#2");
    expect(archive.getMessage(reply)).toBeDefined();

    // The common next change to a live mbox is an append; it must not delete the message either.
    await appendFile(mbox, APPENDED);
    expect((await syncFiles(archive, [root])).report).toMatchObject({ added: 1, deleted: 0 });
    expect(archive.getMessage(reply)).toBeDefined();

    // Removing the broken entry for good releases the message.
    await writeFile(mbox, broken.replace(/From bob@example\.com[\s\S]*?\n\n(?=From )/, "") + APPENDED);
    expect((await syncFiles(archive, [root])).report.deleted).toBe(1);
    expect(archive.getMessage(reply)).toBeUndefined();
    archive.close();
  });

  it("keeps every message of an indexed mbox whose head gains stray bytes", async () => {
    const root = await copyFixtures();
    const mbox = join(root, "takeout.mbox");
    const archive = new Archive();
    await syncFiles(archive, [root]);
    const original = await readFile(mbox);

    await writeFile(mbox, Buffer.concat([Buffer.from("stray line before the first separator\n"), original]));
    const stray = await syncFiles(archive, [root]);
    expect(stray.report.deleted).toBe(0);
    expect(stray.result.failures.map((failure) => failure.error)).toContain("not an mbox file: content before the first From_ separator");
    expect(archive.status().messageCount).toBe(5);

    // An editor-added UTF-8 BOM is not stray content.
    await writeFile(mbox, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]));
    expect((await syncFiles(archive, [root])).report).toMatchObject({ added: 0, deleted: 0 });
    expect(archive.status().messageCount).toBe(5);
    archive.close();
  });

  it("treats a files sync as authoritative for its account across moved roots and dropped paths", async () => {
    const root = await copyFixtures();
    const archive = new Archive();
    await syncFiles(archive, [root, join(root, "takeout.mbox")]);
    expect(archive.status().messageCount).toBe(5);

    // Dropping the second --path releases nothing that the first root still holds.
    expect((await syncFiles(archive, [root])).report.deleted).toBe(0);

    // A moved root is a new root; once the old one is released, deletions under the new one take effect.
    const moved = join(dirname(root), "moved");
    await rename(root, moved);
    expect((await syncFiles(archive, [moved])).report).toMatchObject({ added: 0, deleted: 0 });
    await rm(join(moved, "eml", "renewal.eml"));
    expect((await syncFiles(archive, [moved])).report.deleted).toBe(1);
    expect(archive.getMessage(messageKey("eml", "<renewal-1@example.com>"))).toBeUndefined();
    archive.close();
  });

  it("reports an unlistable directory without aborting or deleting what it held", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = await copyFixtures();
    const archive = new Archive();
    await syncFiles(archive, [root]);

    await chmod(join(root, "eml"), 0o000);
    try {
      const { result, report } = await syncFiles(archive, [root]);
      expect(report.deleted).toBe(0);
      expect(result.failures).toContainEqual(expect.objectContaining({ providerKey: "backup/eml", error: "directory cannot be read (EACCES)" }));
      expect(JSON.stringify(result.failures)).not.toContain(dirname(root));
      expect(archive.status().messageCount).toBe(5);
    } finally {
      await chmod(join(root, "eml"), 0o755);
    }
    archive.close();
  });

  it("reads an Apple Mail export bundle and ignores an empty Message-ID", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mailcrawl-issue-41-bundle-"));
    scratch.push(dir);
    const bundle = join(dir, "Inbox.mbox");
    await mkdir(bundle);
    const entry = (body: string) => `From a@example.com Sat Aug 29 07:30:00 2026\nMessage-ID: <>\nFrom: a@example.com\nSubject: ${body}\n\n${body}\n\n`;
    await writeFile(join(bundle, "mbox"), entry("first") + entry("second"));
    await writeFile(join(bundle, "table_of_contents"), "binary index");

    const { result, report } = await syncFiles(new Archive(), [bundle]);
    expect(result.messages.map((message) => [message.mailbox, message.subject])).toEqual([["Inbox", "first"], ["Inbox", "second"]]);
    expect(result.duplicates).toEqual([]);
    expect(report.added).toBe(2);
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
