import { cpSync, existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

/**
 * 邮件数据快照（2026-10-07）。
 *
 * 为什么需要：整个项目里 `data/ideas.json` 有 6 小时一次的异地备份，而**邮件库
 * （`.eml` + SQLite）此前一份备份都没有**——它是唯一不可再生的数据（服务商侧删掉的
 * 邮件只有本地有），却体量最大（GB 级）。MAIL-AGENT.md 第八节第 7 步把"正经备份"
 * 绑在 OSS（待购买）上，这里给出**不依赖任何外部服务**的过渡方案。
 *
 * 做法：
 * - SQLite 用 better-sqlite3 的在线备份 API（`db.backup`）——**运行中也能拿到一致快照**，
 *   不需要停容器、也不需要 sqlite3 CLI（宿主上未必有）；
 * - `eml/` 用**硬链接**（同一文件系统时几乎零成本）：`.eml` 一旦写入就不再改内容，
 *   且写入走 tmp + rename（rename 换的是目录项，旧 inode 仍被快照持有）→ 硬链安全；
 *   跨文件系统时自动退化为复制；
 * - `accounts.json` / `credentials.json`（600）一并快照——没有凭据就无法恢复可用实例；
 * - 保留最近 `keep` 份，更旧的目录删掉。
 *
 * ⚠ **它仍然在同一块盘上**：防的是误删、误改、跑飞了的脚本与半截写入，**不防磁盘损坏**。
 *   异地那一半（OSS / 另一台 VPS）在第十节待定项里，别把这份当成完整备份。
 */

export interface BackupOptions {
  /** 数据目录（容器内 = WEBMAIL_DATA_DIR，缺省 /data） */
  dataDir: string;
  /** 快照根目录，缺省 `<dataDir>/backups` */
  outDir?: string;
  /** 保留份数（缺省 7） */
  keep?: number;
  /** 时间戳（测试注入用；缺省 = 当前时间） */
  stamp?: string;
  /** 打印进度（CLI 用） */
  log?: (msg: string) => void;
}

export interface BackupResult {
  dir: string;
  /** 每类数据的落盘字节数 */
  bytes: { db: number; eml: number; config: number };
  files: { db: number; eml: number; config: number };
  /** 被清理掉的旧快照目录名 */
  pruned: string[];
  skipped: string[];
}

/** `2026-10-07T12-34-56` 形态的目录名：可排序、无冒号（跨平台文件名安全） */
export function backupStamp(now = new Date()): string {
  return now.toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
}

function dirSize(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = dirSize(abs);
      bytes += sub.bytes;
      files += sub.files;
    } else if (entry.isFile()) {
      bytes += statSync(abs).size;
      files++;
    }
  }
  return { bytes, files };
}

/** 硬链接优先、跨文件系统退化为复制（`.eml` 内容不可变，硬链等价于快照） */
function linkOrCopy(from: string, to: string): void {
  try {
    linkSync(from, to);
  } catch {
    cpSync(from, to, { recursive: true, force: true });
  }
}

/** 备份 SQLite：在线备份 API，WAL 下的写入不会进到快照里（一致点） */
async function backupDb(from: string, to: string): Promise<void> {
  const db = new Database(from, { readonly: true, fileMustExist: true });
  try {
    await db.backup(to);
  } finally {
    db.close();
  }
}

export async function runBackup(opts: BackupOptions): Promise<BackupResult> {
  const log = opts.log ?? (() => {});
  const { dataDir } = opts;
  if (!existsSync(dataDir)) throw new Error(`数据目录不存在：${dataDir}`);
  const outRoot = opts.outDir ?? join(dataDir, "backups");
  const keep = Math.max(1, opts.keep ?? 7);
  const stamp = opts.stamp ?? backupStamp();
  const dir = join(outRoot, stamp);
  mkdirSync(dir, { recursive: true });

  const bytes = { db: 0, eml: 0, config: 0 };
  const files = { db: 0, eml: 0, config: 0 };
  const skipped: string[] = [];

  // 1) SQLite（webmail.db / 将来的 mail.db / agent.db）——有哪个备哪个
  for (const name of ["webmail.db", "mail.db", "agent.db"]) {
    const from = join(dataDir, name);
    if (!existsSync(from)) continue;
    const to = join(dir, name);
    await backupDb(from, to);
    const size = statSync(to).size;
    bytes.db += size;
    files.db++;
    log(`  ${name} → ${(size / 1024).toFixed(0)} KB`);
  }
  // WAL / SHM 不进快照：快照里的库是完整的（backup API 已把 WAL 内容合并进去）
  if (files.db === 0) skipped.push("没有找到任何 SQLite 库");

  // 2) 原文目录
  const emlDir = join(dataDir, "eml");
  if (existsSync(emlDir)) {
    const target = join(dir, "eml");
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(emlDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      linkOrCopy(join(emlDir, entry.name), join(target, entry.name));
    }
    const stat = dirSize(target);
    bytes.eml = stat.bytes;
    files.eml = stat.files;
    log(`  eml/ → ${files.eml} 个文件，${(bytes.eml / 1024 / 1024).toFixed(1)} MB`);
  } else {
    skipped.push("没有 eml/ 目录");
  }

  // 3) 配置与凭据（凭据在快照里同样保持 600）
  for (const name of ["accounts.json", "credentials.json"]) {
    const from = join(dataDir, name);
    if (!existsSync(from)) {
      skipped.push(`缺少 ${name}`);
      continue;
    }
    const to = join(dir, name);
    cpSync(from, to);
    if (name === "credentials.json") {
      const { chmodSync } = await import("node:fs");
      chmodSync(to, 0o600);
    }
    const size = statSync(to).size;
    bytes.config += size;
    files.config++;
    log(`  ${name} → ${size} B`);
  }

  // 4) 清理旧快照（只认我们自己建的目录名形态，避免误删用户放进来的东西）
  const pruned: string[] = [];
  if (existsSync(outRoot)) {
    const snapshots = readdirSync(outRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort();
    for (const name of snapshots.slice(0, Math.max(0, snapshots.length - keep))) {
      rmSync(join(outRoot, name), { recursive: true, force: true });
      pruned.push(name);
    }
  }

  return { dir, bytes, files, pruned, skipped };
}

/** CLI：`tsx src/backup.ts [--keep N] [--out DIR]`（容器内由 scripts/backup-webmail.sh 调用） */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dataDir = process.env.WEBMAIL_DATA_DIR ?? "/data";
  const keep = Number(arg("keep") ?? process.env.WEBMAIL_BACKUP_KEEP ?? 7);
  console.log(`[backup] 数据目录 ${dataDir}，保留 ${keep} 份`);
  const started = Date.now();
  const result = await runBackup({
    dataDir,
    outDir: arg("out"),
    keep,
    log: (m) => console.log(m),
  });
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  console.log(
    `[backup] 完成：${result.dir}（库 ${result.files.db} 个 / ${mb(result.bytes.db)} MB，` +
      `原文 ${result.files.eml} 个 / ${mb(result.bytes.eml)} MB，配置 ${result.files.config} 个），` +
      `耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
  if (result.pruned.length > 0) console.log(`[backup] 清理旧快照：${result.pruned.join(", ")}`);
  if (result.skipped.length > 0) console.log(`[backup] 跳过：${result.skipped.join("；")}`);
  console.log(
    "[backup] ⚠ 快照与原数据在同一块盘上：防误删/误改，不防磁盘损坏；异地那份仍待 OSS（MAIL-AGENT.md 第十节）"
  );
}

// 仅作为入口脚本运行时执行（被 import 时不跑）
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("[backup] 失败：", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
