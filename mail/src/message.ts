import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import sanitizeHtml from "sanitize-html";
import type { Db } from "./db.js";
import type { NewMeta } from "./imap.js";
import type { AttachmentEntry } from "./mime.js";

/** Message-ID 规范化：去尖括号、去空白、小写（副本去重键，4.2） */
export function normalizeMessageId(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const v = raw.replace(/[<>]/g, "").trim().toLowerCase();
  return v.length > 0 ? v : null;
}

/**
 * 规范化引用键：与库键同形（`mid:<normalized>`）。
 * 额外剔除引号与反斜线——refs_json 以 JSON 存储、按带引号子串精确匹配（thread.ts），
 * 原始值若含这两类字符会破坏匹配语义（RFC 上 Message-ID 本就不允许它们）。
 */
export function refKeyOf(raw: string | undefined | null): string | null {
  const bare = raw?.replace(/[<>\\"]/g, "").trim().toLowerCase();
  return bare ? `mid:${bare}` : null;
}

/** 从解析结果提取引用链：References 各环 + In-Reply-To 尾环，去重保序（4.7） */
export function extractRefKeys(parsed: ParsedMail): string[] {
  const refs = Array.isArray(parsed.references)
    ? parsed.references
    : parsed.references
      ? [parsed.references]
      : [];
  const keys: string[] = [];
  for (const raw of [...refs, parsed.inReplyTo]) {
    const k = refKeyOf(raw);
    if (k && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

/** mailparser 的地址头：同名头出现多次时是数组，归一化后平铺 value */
function addressValues(v: AddressObject | AddressObject[] | undefined) {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return list.flatMap((a) => a.value);
}

function sha1(input: string | Buffer): string {
  return createHash("sha1").update(input).digest("hex");
}

function stripHtml(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} });
}

/** 摘要口径（列表行第二行）：压平空白、截 200 字。webmail 侧按需取原文时复用（source.ts） */
export function snippetOf(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Message-ID 缺失时的回退键：(From, Date, Subject) 规范化哈希（副本间三者一致） */
function messageKey(mid: string | null, fromAddr: string, dateIso: string, subject: string): string {
  if (mid) return `mid:${mid}`;
  return `auto:${sha1(`${fromAddr}|${dateIso}|${subject}`)}`;
}

export interface IngestInput {
  accountId: string;
  folder: string;
  meta: NewMeta;
  /** 原文；缺省 = 只存元数据（truncated=1、eml_path 为空） */
  source?: Buffer;
  /**
   * 这份原文是**精简版**（正文 + 内嵌图，附件没下载）——见 mail/src/mime.ts。
   * 给了它：`truncated=1`（本地不是完整原件）+ 清单落 `attachments_json`。
   */
  parts?: { attachments: AttachmentEntry[] };
}

export interface IngestResult {
  messageId: string;
  created: boolean;
}

/**
 * 一封邮件入库：messages 按 Message-ID 只存一份（多副本共享），
 * copies 按（账号, 文件夹, UID）各存一行。幂等：重复入库不产生新行。
 */
export async function ingestMessage(
  db: Db,
  dataDir: string,
  input: IngestInput
): Promise<IngestResult> {
  const { meta } = input;
  const env = meta.envelope;
  // 头部信息的**兜底**来自 ENVELOPE：只在「拿不到原文」时才是唯一来源（超大邮件只存
  // 元数据，红线 12，调用方会用 `fetchEnvelopes` 单独补一次）。
  let fromAddr = env?.from?.[0]?.address ?? "";
  let fromName = env?.from?.[0]?.name ?? "";
  let dateIso = (env?.date ?? meta.internalDate ?? new Date()).toISOString();
  let subject = env?.subject ?? "";
  let mid = normalizeMessageId(env?.messageId);

  let bodyText = "";
  let toJson = "[]";
  let ccJson = "[]";
  let size = meta.size;
  let refsJson = "[]";
  let hasAttach = 0;

  if (input.source) {
    const parsed = await simpleParser(input.source);
    // ⚠ 有原文时头部**一律取原文的解析结果**（2026-10-08 性能改动）：元数据那一遍
    //   FETCH 已经不带 ENVELOPE 了——真机 QQ 实测 ENVELOPE 每封 ~15ms，而 flags/size/
    //   date 合计只要 0.7ms，元数据遍 95% 的时间都花在让服务端重新生成 ENVELOPE 上，
    //   而原文反正要下载、这里也反正要解析。字段口径与 ENVELOPE 一致（都是解码后的
    //   显示名/地址/主题/日期）。ENVELOPE 缺失时上面的兜底值会保留（解析不出就退回
    //   internalDate 等）。
    fromAddr = parsed.from?.value?.[0]?.address ?? fromAddr;
    fromName = parsed.from?.value?.[0]?.name ?? fromName;
    subject = parsed.subject ?? subject;
    mid = normalizeMessageId(parsed.messageId) ?? mid;
    dateIso = (parsed.date ?? meta.internalDate ?? new Date()).toISOString();
    bodyText = parsed.text ?? (typeof parsed.html === "string" ? stripHtml(parsed.html) : "");
    toJson = JSON.stringify(addressValues(parsed.to));
    ccJson = JSON.stringify(addressValues(parsed.cc));
    // ⚠ 精简原文（partial）里 `size` 要记**原始大小**（元数据里免费带回来的 RFC822.SIZE）：
    //   界面显示的是「这封邮件多大」，按需补取的上限判断也要用真实大小，而不是精简后的字节数
    size = input.parts ? size : input.source.length;
    refsJson = JSON.stringify(extractRefKeys(parsed));
    // 附件指示口径（4.2）：只算「可下载附件」，内嵌图（inline）不算
    hasAttach = parsed.attachments.some((a) => a.contentDisposition === "attachment") ? 1 : 0;
  } else if (env) {
    toJson = JSON.stringify(env.to ?? []);
    ccJson = JSON.stringify(env.cc ?? []);
  }

  const messageId = messageKey(mid, fromAddr, dateIso, subject);
  // ⚠ 两种「不完整」都记 truncated=1，靠 eml_path 区分（见 db.ts 的说明）：
  //   parts 给了 = 精简原文（正文可读、附件没下）→ truncated=1 且 eml_path 有值
  //   没有 source = 只有索引 → truncated=1 且 eml_path 为空
  const partial = !!input.source && !!input.parts;
  const truncated = input.source && !partial ? 0 : 1;
  const emlRel = input.source ? join("eml", `${sha1(messageId)}.eml`) : "";
  const attachmentsJson = input.parts ? JSON.stringify(input.parts.attachments) : null;

  const existing = db
    .prepare("SELECT message_id FROM messages WHERE message_id = ?")
    .get(messageId) as { message_id: string } | undefined;

  let created = false;
  if (!existing) {
    if (input.source) {
      // 原文 .eml 原子写入（先查再写，单进程无并发）
      const abs = join(dataDir, emlRel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs + ".tmp", input.source);
      renameSync(abs + ".tmp", abs);
    }
    const insertAll = db.transaction(() => {
      db.prepare(
        `INSERT INTO messages (message_id, date, from_addr, from_name, to_json, cc_json, subject, snippet, size, truncated, first_seen, eml_path, refs_json, has_attach, attachments_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        messageId,
        dateIso,
        fromAddr,
        fromName,
        toJson,
        ccJson,
        subject,
        snippetOf(bodyText),
        size,
        truncated,
        new Date().toISOString(),
        emlRel,
        refsJson,
        hasAttach,
        attachmentsJson
      );
      db.prepare(
        "INSERT INTO messages_fts (message_id, subject, from_text, to_text, body) VALUES (?, ?, ?, ?, ?)"
      ).run(messageId, subject, `${fromName} ${fromAddr}`.trim(), toAddresses(toJson), bodyText);
    });
    insertAll();
    created = true;
  }

  db.prepare(
    `INSERT INTO copies (account_id, folder, uid, message_id, flags)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (account_id, folder, uid) DO UPDATE SET message_id = excluded.message_id, flags = excluded.flags`
  ).run(input.accountId, input.folder, meta.uid, messageId, meta.flags.join(" "));

  return { messageId, created };
}

function toAddresses(toJson: string): string {
  const list = JSON.parse(toJson) as { address?: string }[];
  return list.map((a) => a.address ?? "").join(" ");
}

/** 集合化清理用的临时表名（连接级 TEMP 表，见 pruneOrphanMessages） */
const PRUNE_IDS = "tmp_prune_message_ids";
const PRUNE_ROWIDS = "tmp_prune_fts_rowids";

export interface PruneOptions {
  /** 只在这批 message_id 里挑孤儿（批量删除 / 移动用）；不给 = 全库扫一遍 */
  candidates?: string[];
  /** 给了就把这些邮件的原文 `.eml` 路径一并收集出来（调用方在**事务提交后**删文件） */
  collectEml?: boolean;
}

export interface PruneResult {
  /** 清掉的邮件数（messages + FTS 行） */
  removed: number;
  /** 被清理邮件的原文相对路径（`eml/xxx.eml`）——交给 `removeEmlFiles` 在事务外删 */
  emlPaths: string[];
}

/**
 * 清理「已经没有任何副本」的邮件本体与全文索引行。
 *
 * ⚠ **必须集合化做，不要逐封循环**（2026-10-08 实测事故）：`messages_fts` 的
 * `message_id` 是 `UNINDEXED` 列，按它过滤删除每次都退化成「全表扫一遍 FTS 内容表」
 * ——逐封删 = O(n²)。删除一个有 6500 封邮件副本的账号实测 **41.3 秒**，而
 * better-sqlite3 是同步 API，这期间 webmaild 的事件循环被整个占住（`/health`、
 * `/messages` 全部无响应），用户看到的就是「确认删除后页面硬卡几十秒」。
 * 改成「物化孤儿集合 → 一次扫出 FTS rowid → 按 rowid 删」后同一份数据 **< 1 秒**。
 * （`test/orphan-prune.test.ts` 用源码扫描锁住这条：按 message_id 删 FTS 的写法
 * 只允许出现在 source.ts 的单封替换处。）
 *
 * 调用约定：**先删 `copies`，再调它**（「没有副本」= 孤儿）。
 * - `candidates` 给了：只在这批 message_id 里挑孤儿（批量删除 / 移动用）；
 * - 不给：全库扫一遍找孤儿（整账号删除、UIDVALIDITY 重建用）。
 */
export function pruneOrphanMessages(db: Db, opts: PruneOptions = {}): PruneResult {
  const candidates = opts.candidates;
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${PRUNE_IDS}(message_id TEXT PRIMARY KEY)`);
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${PRUNE_ROWIDS}(rowid INTEGER PRIMARY KEY)`);
  db.exec(`DELETE FROM ${PRUNE_IDS}`);
  db.exec(`DELETE FROM ${PRUNE_ROWIDS}`);

  if (candidates) {
    const insert = db.prepare(`INSERT OR IGNORE INTO ${PRUNE_IDS}(message_id) VALUES (?)`);
    db.transaction(() => {
      for (const id of candidates) insert.run(id);
    })();
    // 只留真的没有副本的（同一批里可能有邮件还有别的副本）
    db.exec(
      `DELETE FROM ${PRUNE_IDS} WHERE EXISTS (SELECT 1 FROM copies c WHERE c.message_id = ${PRUNE_IDS}.message_id)`
    );
  } else {
    db.exec(
      `INSERT OR IGNORE INTO ${PRUNE_IDS}
       SELECT m.message_id FROM messages m
       WHERE NOT EXISTS (SELECT 1 FROM copies c WHERE c.message_id = m.message_id)`
    );
  }

  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${PRUNE_IDS}`).get() as { n: number };
  if (n === 0) return { removed: 0, emlPaths: [] };

  // 原文路径要在删行**之前**取出来（行没了就查不到了）。文件本身留到事务提交后再删——
  // 先删文件后删行，一旦提交失败就永久丢了原文（本地是唯一副本之外的东西，宁可漏删）。
  const emlPaths = opts.collectEml
    ? (
        db
          .prepare(
            `SELECT eml_path FROM messages WHERE eml_path != '' AND message_id IN (SELECT message_id FROM ${PRUNE_IDS})`
          )
          .all() as { eml_path: string }[]
      ).map((r) => r.eml_path)
    : [];

  // FTS：只扫一遍内容表把要删的 rowid 物化出来，再按 rowid 删（FTS5 的 docid = rowid）。
  // 不要在 DELETE 的 WHERE 里直接 JOIN 同一张 FTS 表——那会退化成逐行求值。
  db.exec(
    `INSERT OR IGNORE INTO ${PRUNE_ROWIDS}(rowid)
     SELECT f.rowid FROM messages_fts f JOIN ${PRUNE_IDS} t ON t.message_id = f.message_id`
  );
  db.prepare(`DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM ${PRUNE_ROWIDS})`).run();
  db.prepare(`DELETE FROM messages WHERE message_id IN (SELECT message_id FROM ${PRUNE_IDS})`).run();
  db.exec(`DELETE FROM ${PRUNE_IDS}`);
  db.exec(`DELETE FROM ${PRUNE_ROWIDS}`);
  return { removed: n, emlPaths };
}

/**
 * 删除原文文件（在**事务提交后**调用，best-effort：单个失败不影响其它）。
 *
 * ⚠ 为什么必须显式删：`eml/` 是数据库之外的真实文件，删 `messages` 行不会带走它们——
 * 2026-10-08 实测：删掉一个 6700 封的账号后索引只剩 15 封，而 `eml/` 仍留着
 * **6707 个文件 / 438MB**（原文永远不会再被引用，但一直占着磁盘）。
 * 只接受库自己生成的 `eml/...` 相对路径（防越权删除）。
 */
export function removeEmlFiles(dataDir: string, emlPaths: string[]): number {
  let removed = 0;
  for (const rel of emlPaths) {
    if (!rel.startsWith("eml/")) continue;
    try {
      rmSync(join(dataDir, rel), { force: true });
      removed++;
    } catch {
      // 单个文件删不掉（权限/占用）不影响其它；调用方只看汇总
    }
  }
  return removed;
}

/**
 * 存量回填（4.7）：refs_json 仍为 NULL 且留有原文的行，重解析原文提取引用链与附件标记。
 * 幂等（只动 NULL 行）；单行失败跳过并计数，不阻塞启动。
 */
export async function backfillRefs(db: Db, dataDir: string): Promise<{ updated: number; failed: number }> {
  const rows = db
    .prepare("SELECT message_id, eml_path FROM messages WHERE refs_json IS NULL AND eml_path != ''")
    .all() as { message_id: string; eml_path: string }[];
  if (rows.length === 0) return { updated: 0, failed: 0 };
  const update = db.prepare("UPDATE messages SET refs_json = ?, has_attach = ? WHERE message_id = ?");
  let updated = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const raw = readFileSync(join(dataDir, row.eml_path));
      const parsed = await simpleParser(raw);
      const hasAttach = parsed.attachments.some((a) => a.contentDisposition === "attachment") ? 1 : 0;
      update.run(JSON.stringify(extractRefKeys(parsed)), hasAttach, row.message_id);
      updated++;
    } catch {
      failed++;
    }
  }
  return { updated, failed };
}
