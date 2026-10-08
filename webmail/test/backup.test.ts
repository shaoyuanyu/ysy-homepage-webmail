import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../../mail/src/db.js";
import { backupStamp, runBackup } from "../src/backup.js";

/**
 * 邮件数据快照（2026-10-07）。不依赖容器：直接对临时目录跑，验证
 * 「库一致快照 / eml 硬链 / 凭据 600 / 保留份数清理」四件事。
 */
const root = join(import.meta.dirname, "..", ".test-data", "backup");

function makeData(name: string): string {
  const dir = join(root, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "eml"), { recursive: true });
  // 真库（带 WAL）：验证在线备份能拿到内容
  const db = openDb(join(dir, "webmail.db"));
  db.prepare(
    `INSERT INTO messages (message_id, date, from_addr, from_name, to_json, cc_json, subject,
       snippet, size, truncated, first_seen, eml_path, refs_json, has_attach)
     VALUES ('mid:a@x','2026-10-01T00:00:00Z','a@b.c','A','[]','[]','hi','hi',1,0,'2026-10-01T00:00:00Z','','[]',0)`
  ).run();
  db.close();
  writeFileSync(join(dir, "eml", "a.eml"), "Subject: hi\r\n\r\nbody\r\n");
  writeFileSync(join(dir, "accounts.json"), JSON.stringify({ accounts: [] }));
  writeFileSync(join(dir, "credentials.json"), JSON.stringify({ acc1: { username: "u", password: "p" } }), {
    mode: 0o600,
  });
  return dir;
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("backupStamp", () => {
  it("可排序、无冒号（跨平台文件名安全）", () => {
    expect(backupStamp(new Date("2026-10-07T12:34:56.789Z"))).toBe("2026-10-07T12-34-56");
  });
});

describe("runBackup：快照内容", () => {
  it("库 / eml / 凭据都进快照，且库是可用的一致副本", async () => {
    const dataDir = makeData("basic");
    const out = join(root, "basic-out");
    const r = await runBackup({ dataDir, outDir: out, stamp: "2026-10-07T00-00-00" });

    // 库：能打开、行还在（在线备份 API 的产物是完整 SQLite 文件）
    const dbPath = join(r.dir, "webmail.db");
    expect(existsSync(dbPath)).toBe(true);
    const db = openDb(dbPath);
    const row = db.prepare("SELECT subject FROM messages WHERE message_id = 'mid:a@x'").get() as {
      subject: string;
    };
    expect(row.subject).toBe("hi");
    db.close();

    // eml：硬链（同 inode）——内容一致且不占额外空间
    const emlFrom = statSync(join(dataDir, "eml", "a.eml"));
    const emlTo = statSync(join(r.dir, "eml", "a.eml"));
    expect(emlTo.ino).toBe(emlFrom.ino);
    expect(readFileSync(join(r.dir, "eml", "a.eml"), "utf8")).toContain("body");

    // 凭据：600 权限一并保留
    const mode = statSync(join(r.dir, "credentials.json")).mode & 0o777;
    expect(mode).toBe(0o600);

    expect(r.files).toMatchObject({ db: 1, eml: 1, config: 2 });
  });

  it("保留最近 N 份，更旧的目录被清掉（不碰不像快照的目录）", async () => {
    const dataDir = makeData("keep");
    const out = join(root, "keep-out");
    mkdirSync(join(out, "manual-keep-me"), { recursive: true }); // 非快照目录：不能删
    for (const stamp of ["2026-10-01T00-00-00", "2026-10-02T00-00-00", "2026-10-03T00-00-00"]) {
      await runBackup({ dataDir, outDir: out, keep: 2, stamp });
    }
    const names = ["2026-10-01T00-00-00", "2026-10-02T00-00-00", "2026-10-03T00-00-00"];
    const kept = names.filter((n) => existsSync(join(out, n)));
    expect(kept).toEqual(["2026-10-02T00-00-00", "2026-10-03T00-00-00"]);
    expect(existsSync(join(out, "manual-keep-me"))).toBe(true);
  });

  it("没有 eml/ 与部分配置时不报错，只在 skipped 里说明", async () => {
    const dataDir = join(root, "sparse");
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    const r = await runBackup({ dataDir, outDir: join(root, "sparse-out"), stamp: "2026-10-07T00-00-00" });
    expect(r.files.db).toBe(0);
    expect(r.skipped.join(" ")).toContain("eml/");
    expect(r.skipped.join(" ")).toContain("accounts.json");
  });

  it("数据目录不存在 → 明确报错（不是静默建一个空快照）", async () => {
    await expect(
      runBackup({ dataDir: join(root, "nope"), outDir: join(root, "nope-out") })
    ).rejects.toThrow("数据目录不存在");
  });
});
