import type { ImapFlow } from "imapflow";
import type { Db } from "./db.js";
import {
  connectAccount,
  fetchEnvelopes,
  fetchParts,
  fetchSource,
  fetchSources,
  fetchStructures,
  flattenStructure,
  listFlagsSince,
  listMetaRange,
  listNewMeta,
  openReadOnly,
  partSignature,
  type EnvelopeInfo,
  type NewMeta,
  type PartLeaf,
} from "./imap.js";
import { buildTrimmedSource, collectPartIds, planParts, pruneTree } from "./mime.js";
import { ingestMessage, pruneOrphanMessages, removeEmlFiles } from "./message.js";
import type { AccountConfig, AccountCredential, SyncResult } from "./types.js";

/**
 * 增量抓取（红线 10：同一账号一条连接、串行遍历文件夹）。
 *
 * ## 首轮为什么这么写（2026-10-08 重做，起因是一次真实事故）
 *
 * 旧实现有两处让「新加一个邮箱」变成几十分钟的黑箱：
 * 1. 逐封 `fetchOne` 取原文——6500 封 = 6500 次 IMAP 往返，实测稳定在 ~8 封/秒
 *    （生产上更慢）。现在的做法：**一次 FETCH 命令取一批原文**（按条数 + 字节分组），
 *    服务端流式回吐、边到边落盘。
 * 2. `last_seen_uid` 只在「整个文件夹抓完」时落库——中途重启/部署 = 从 UID 1 全部
 *    重来（数据幂等不会重复，但时间全丢；生产上曾因此跨了三天）。现在改成
 *    **按块推进的倒序回填**：
 *    - 首轮不再从小到大扫：先把 `last_seen_uid` 钉在「加入账号那一刻的最大 UID」，
 *      然后 `backfill_uid` 从最大 UID **往下**逐块推进——于是**最近的邮件第一时间
 *      就进库**（打开邮箱立刻能看到今天/这个月的信，而不是 2015 年的）。
 *    - 每块（缺省 60 封 / 24MiB）抓完立即落库游标：重启、部署、断线只丢当前这一块。
 *    - 回填期间每轮**先跑增量再回填**——回填不等于暂停新邮件。
 *
 * 回填分块由调用方的「回填泵」驱动（webmaild 的 index.ts / mailagentd 的 idle.ts）：
 * 一次 `syncFolder` 只吃一块，账号锁的单次持有时长因此被压到一个块（几秒）以内——
 * 首轮回填期间 LIST / 发信 / 标记不再被卡十几分钟。
 *
 * ⚠ `ingested` 只报**增量**（新邮件），回填的旧邮件不进这个数组：它喂给 agent 的
 * 触发接线（judge/command），把几千封历史邮件投成模型任务既贵又没意义。
 * 回填数量走 `backfilled` 字段，只用于进度显示（也不参与 lastNewMail 判定）。
 */

/** 标记回读窗口（3.5：收窄范围，全量重取会打爆服务商） */
const FLAGS_WINDOW_DAYS = 90;
/**
 * **附件门控**（2026-10-08，用户定的策略）：超过该大小的邮件，同步时**不下载附件**——
 * 只取「邮件头 + 正文 + 内嵌图（cid）」拼成精简原文，附件按序号记进清单
 * （`messages.attachments_json`），等用户在站内点开、点某个附件时才按部件号取
 * （见 webmail/src/source.ts；agent 侧见 mail/src/reader.ts）。
 *
 * 为什么不是「所有邮件都不下附件」：判定一封邮件有没有附件必须读 `BODYSTRUCTURE`，
 * 真机 QQ 实测 **75~97ms/封**（比取原文本身 37ms/封还贵）。6709 封全读一遍要
 * **+8~11 分钟**，而整个邮箱的附件字节只有 137MB（≈25 秒 @5.4MB/s）——严格版净亏。
 * 按体积门控只对「大到可能藏大附件」的邮件读结构：你这库里 >500KB 的只有 93 封
 * （2.2%，却占 75% 的字节），结构读取成本降到 ~8 秒。
 * ⚠ 门控只是**实现上的分流**，不是策略：小邮件整封下载，是因为它的附件本来就只有几十 KB。
 * ⚠ 分流阈值可用 `MAIL_AGENT_MAX_SOURCE_BYTES` 调；按需补取的上限见
 *   `WEBMAIL_MAX_ONDEMAND_BYTES`（缺省 200MB）。
 */
const MAX_SOURCE_BYTES = Number(process.env.MAIL_AGENT_MAX_SOURCE_BYTES ?? 500 * 1024);
/**
 * **硬上限**：连「正文」都不取的界线（缺省 50MB，即原 `MAX_SOURCE_BYTES` 的老值）。
 * 门控之上的邮件走「只取正文 + 内嵌图」，但正文本身也可能很大（几十 MB 的纯文本简报、
 * 或者 OTP 之外把整个 PDF 塞进 text/html 的怪邮件）——超过这条线一律**只存索引**
 * （红线 12：只存元数据、按需拉），绝不因为「正文」两个字就把几十 MB 拉下来。
 */
const MAX_PARTIAL_BYTES = Number(process.env.MAIL_AGENT_MAX_PARTIAL_BYTES ?? 50 * 1024 * 1024);

/** 一个回填块最多处理多少封（账号锁单次持有时长 ≈ 块大小 / 抓取速率） */
const BACKFILL_CHUNK = Number(process.env.MAIL_AGENT_BACKFILL_CHUNK ?? 200);
/**
 * 一个回填块的时间预算（毫秒，双上限的另一半）。
 * 条数上限保护「快链路上的锁持有」，时间预算保护「慢链路」——生产上到 QQ 的实测
 * 只有 ~2 封/秒，只按条数算一块会占锁 100 秒。8 秒是「用户点一下文件夹选择器
 * 最多等 8 秒」的量级（首轮那 13 分钟就是这么摊掉的）。
 * ⚠ 每次分块都要新建连接（红线 10 不允许为回填常驻第二条连接），所以预算不能太小，
 *   否则变成每隔几秒登录一次服务商。
 */
const BACKFILL_BUDGET_MS = Number(process.env.MAIL_AGENT_BACKFILL_BUDGET_MS ?? 8000);
/** 一个回填块的原文字节上限（碰上大附件邮件时先让出锁，下一块继续） */
const BACKFILL_BYTES = Number(process.env.MAIL_AGENT_BACKFILL_BYTES ?? 24 * 1024 * 1024);
/** 一次批量取原文的字节上限（把「一次命令取一批」的批切小，避免峰值内存过大） */
const SOURCE_BATCH_BYTES = Number(process.env.MAIL_AGENT_SOURCE_BATCH_BYTES ?? 8 * 1024 * 1024);
/** 增量一轮最多吃多少封（积压很多时按水位线一段段吃，不把一轮拉成几小时） */
const INCREMENTAL_MAX = Number(process.env.MAIL_AGENT_INCREMENTAL_MAX ?? 500);
/** 自适应分批的起手批大小（先小步，再按实测速率放大到吃满时间预算） */
const SUB_BATCH_MIN = Number(process.env.MAIL_AGENT_SUB_BATCH_MIN ?? 10);
/**
 * **回填期间**标记回读的最小间隔（毫秒，缺省 10 分钟；回填一结束立刻恢复每轮都读）。
 *
 * 起因（2026-10-08 第二轮实测）：在 QQ 上标记回读**每个文件夹**要 ~2 秒——它是一条
 * `SEARCH SINCE`（贵的是命令本身：只有 1 封邮件的「已发送」也要 1.9s），一个 6 文件夹的
 * 账号每轮就是 ~12 秒，而回填期间每 60 秒就有一轮全量。首轮回填时这些时间纯属浪费：
 * 该读回来的标记，回填本身入库每封时已经带上了（`meta.flags`），真正需要「读回」的
 * 只是「别处（手机/网页版）改过的已读/星标」，让它们晚几分钟不致命。
 * ⚠ 回填结束后（`hasPendingBackfill` 为假）立刻回到每轮都读，不改变稳态语义。
 */
const FLAGS_BACKFILL_INTERVAL_MS = Number(
  process.env.MAIL_AGENT_FLAGS_BACKFILL_MS ?? 10 * 60_000
);

export interface SyncFolderState {
  uidvalidity: number | null;
  last_seen_uid: number;
  last_flags_sync: string | null;
  backfill_uid: number | null;
  backfill_total: number;
  backfill_remaining: number;
  /** 该（账号, 文件夹）在本地已有的副本数（自愈判据，见 syncFolder） */
  local_copies: number;
}

export interface SyncOptions {
  /**
   * `full`（缺省）：增量 + 一块回填 + 标记回读（常规轮：60s 定时器 / 手动刷新走这条）。
   * `backfill`：**只**推进一块历史回填（回填泵走这条——否则每秒重跑标记回读会打爆服务商）。
   */
  mode?: "full" | "backfill";
}

/**
 * 把原文按「字节 / 条数」切成若干批：每批一次 FETCH 命令。
 * ⚠ 只喂**走整封下载**的邮件（`size <= MAX_SOURCE_BYTES`）；超过门控的由
 * `ingestPartial` 走「结构 + 正文部件」那条路，不进这里。
 */
function batchBySize(
  metas: NewMeta[],
  maxBytes: number,
  maxCount: number
): { uids: number[]; bytes: number }[] {
  const batches: { uids: number[]; bytes: number }[] = [];
  let cur: { uids: number[]; bytes: number } = { uids: [], bytes: 0 };
  for (const m of metas) {
    if (m.size > MAX_SOURCE_BYTES) continue;
    if (cur.uids.length > 0 && (cur.bytes + m.size > maxBytes || cur.uids.length >= maxCount)) {
      batches.push(cur);
      cur = { uids: [], bytes: 0 };
    }
    cur.uids.push(m.uid);
    cur.bytes += m.size;
  }
  if (cur.uids.length > 0) batches.push(cur);
  return batches;
}

/**
 * 「只取正文 + 内嵌图」的入库路径（附件门控，2026-10-08，见 MAX_SOURCE_BYTES）。
 *
 * 流程：① 一批一次取 `BODYSTRUCTURE`（真机 75~97ms/封，所以只对超门控的邮件用）；
 * ② 按结构算出「保留哪些部件」（正文 + cid 内嵌图）与「附件清单」；
 * ③ 把保留部件编号相同的邮件并成一组，一组一次 FETCH 取回「顶层头 + 这些部件」；
 * ④ 拼精简原文（见 mime.ts）入库，附件只留清单。
 *
 * ⚠ **失败即回退**：结构缺失、部件取不全、拼装抛错——一律改成整封下载。
 *   宁可多下几个字节，也不能出现「正文空白 / 附件序号错位」的邮件。
 */
async function ingestPartial(
  db: Db,
  dataDir: string,
  client: ImapFlow,
  accountId: string,
  folder: string,
  metas: NewMeta[]
): Promise<{ messageId: string; created: boolean }[]> {
  const out: { messageId: string; created: boolean }[] = [];
  const byUid = new Map(metas.map((m) => [m.uid, m]));
  /** 需要退回「只存索引」的 uid（连正文都不取，红线 12）；最后统一补一次信封 */
  const metaOnly: number[] = [];
  /** 兜底：能整封下就整封下；连整封都超硬上限 → 记下来走「只存索引」 */
  const fallback = async (uid: number): Promise<void> => {
    const meta = byUid.get(uid);
    if (!meta) return;
    if (meta.size > MAX_PARTIAL_BYTES) {
      metaOnly.push(uid);
      return;
    }
    const source = await fetchSource(client, uid);
    const r = await ingestMessage(db, dataDir, { accountId, folder, meta, source: source ?? undefined });
    out.push({ messageId: r.messageId, created: r.created });
  };
  /**
   * 收尾：只存索引的那些补一次信封（元数据遍**刻意不带 ENVELOPE**，见 imap.ts）——
   * 否则列表里会出现「发件人/主题全空」的行（不报错，只是索引是坏的）。
   */
  const flushMetaOnly = async (): Promise<void> => {
    if (metaOnly.length === 0) return;
    let envelopes = new Map<number, EnvelopeInfo>();
    try {
      envelopes = await fetchEnvelopes(client, metaOnly);
    } catch {
      // 信封取不到也让它们入库（宁可头部空着，也别把邮件丢了）
    }
    for (const uid of metaOnly) {
      const meta = byUid.get(uid);
      if (!meta) continue;
      const r = await ingestMessage(db, dataDir, {
        accountId,
        folder,
        meta: { ...meta, envelope: envelopes.get(uid) },
        source: undefined,
      });
      out.push({ messageId: r.messageId, created: r.created });
    }
  };

  let structures: Map<number, import("./imap.js").StructureNode>;
  try {
    structures = await fetchStructures(client, metas.map((m) => m.uid));
  } catch {
    // 结构都取不到：整批回退（比逐封回退少一半往返）
    for (const m of metas) await fallback(m.uid);
    await flushMetaOnly();
    return out;
  }

  // 分组：要取的部件编号相同 → 一条 FETCH（部件号对整组生效）
  const groups = new Map<
    string,
    { uids: number[]; tree: NonNullable<ReturnType<typeof pruneTree>>; parts: string[]; plan: ReturnType<typeof planParts> }
  >();
  const needFallback: number[] = [];
  for (const m of metas) {
    const root = structures.get(m.uid);
    const leaves = flattenStructure(root);
    if (!root || leaves.length === 0) {
      needFallback.push(m.uid);
      continue;
    }
    // 剪枝后的树：容器层次保真（multipart/alternative 不能被拍成 mixed，见 mime.ts）
    const tree = pruneTree(root);
    if (!tree) {
      // 正文部件一个都没有（比如整封就是一个附件）：回退整封，别存一封空信
      needFallback.push(m.uid);
      continue;
    }
    const parts = collectPartIds(tree);
    const keptSizes = leaves.filter((l) => parts.includes(l.part)).reduce((sum, l) => sum + l.size, 0);
    if (keptSizes > MAX_PARTIAL_BYTES || m.size > MAX_PARTIAL_BYTES) {
      // 正文本身就超硬上限 → 只存索引（红线 12）
      needFallback.push(m.uid);
      continue;
    }
    const sig = partSignature(parts);
    const g = groups.get(sig);
    if (g) g.uids.push(m.uid);
    else groups.set(sig, { uids: [m.uid], tree, parts, plan: planParts(leaves) });
  }

  for (const m of metas) {
    if (needFallback.includes(m.uid)) await fallback(m.uid);
  }

  for (const g of groups.values()) {
    let fetched: Map<number, { headers: Buffer; parts: Map<string, Buffer> }>;
    try {
      fetched = await fetchParts(client, g.uids, g.parts);
    } catch {
      for (const uid of g.uids) await fallback(uid);
      continue;
    }
    for (const uid of g.uids) {
      const meta = byUid.get(uid);
      const got = fetched.get(uid);
      if (!meta || !got) {
        await fallback(uid);
        continue;
      }
      try {
        const source = buildTrimmedSource({
          topHeaders: got.headers,
          tree: g.tree,
          payloads: got.parts,
        });
        // 清单里的 deferred：没随精简原文留存的就是要去服务器取的
        const keptParts = new Set(g.parts);
        const attachments = g.plan.attachments.map((a) => ({
          ...a,
          deferred: !(a.part && keptParts.has(a.part)),
        }));
        const r = await ingestMessage(db, dataDir, {
          accountId,
          folder,
          meta,
          source,
          parts: { attachments },
        });
        out.push({ messageId: r.messageId, created: r.created });
      } catch {
        await fallback(uid);
      }
    }
  }
  await flushMetaOnly();
  return out;
}

/**
 * 入库一组元数据（按给定顺序），并在**时间预算**内自适应分批：
 * - 每批一次 FETCH 命令取原文（`fetchSources`），逐封落盘；
 * - 批大小从 `SUB_BATCH_MIN` 起步，按上一批的实测速率 × 剩余预算放大——
 *   快链路上很快吃满预算，慢链路上批就小，**账号锁的单次持有时长始终有界**
 *   （固定批大小做不到：同一批在 16 封/秒的链路上 1 秒，在 2 封/秒的链路上 25 秒）。
 * - 超预算就停在这批（调用方按已处理条数推进游标/水位线）。
 *
 * 返回实际入库明细（顺序与传入一致；调用方据此定位「处理到哪一封」）。
 */
async function ingestAdaptive(
  db: Db,
  dataDir: string,
  client: ImapFlow,
  accountId: string,
  folder: string,
  metas: NewMeta[],
  deadline: number
): Promise<{ messageId: string; created: boolean }[]> {
  const ingested: { messageId: string; created: boolean }[] = [];
  const pending = new Map(metas.map((m) => [m.uid, m]));
  let done = 0;
  let elapsed = 0;

  while (done < metas.length) {
    if (done > 0 && Date.now() > deadline) break;
    const leftMs = Math.max(0, deadline - Date.now());
    // 自适应批大小：首批求稳（小），之后按实测速率估「剩余预算还能吃几封」
    const estimated =
      done > 0 && elapsed > 0 ? Math.ceil((done / elapsed) * (leftMs / 1000)) : SUB_BATCH_MIN;
    const size = Math.min(BACKFILL_CHUNK, Math.max(SUB_BATCH_MIN, estimated));
    const slice = metas.slice(done, done + size);
    const t0 = Date.now();
    const before = ingested.length;
    /**
     * 草稿不是邮件（2026-10-10）：带 `\Draft` 标记的副本**不入索引**。
     *
     * 判据用标记而不是文件夹名（各服务商的草稿文件夹叫法不同：草稿 / Drafts / [Gmail]/Drafts）；
     * 我们 APPEND 草稿时也带这个标记。这样即使有人把草稿文件夹勾进同步白名单，
     * 草稿也不会变成"邮件"混进列表（展示层还有一道 `NOT_DRAFT_SQL` 兜底）。
     *
     * ⚠ **必须占位计数**：调用方用水位线推在 `ingested` 的最后一条上（`fresh[done.length-1]`），
     *   直接把草稿从数组里剔掉会让水位线停在它前面 → 下一轮又捞出来，永远卡在同一封。
     *   所以这里给每封草稿补一个空 messageId 的占位项（`created: false`），
     *   调用方据此把"没抓正文"从统计里排掉（见 syncFolder 的 fetched 过滤）。
     */
    const draftSlice = slice.filter((m) => (m.flags ?? []).includes("\\Draft"));
    for (let i = 0; i < draftSlice.length; i++) {
      ingested.push({ messageId: "", created: false });
      pending.delete(draftSlice[i].uid);
    }
    const work = slice.filter((m) => !(m.flags ?? []).includes("\\Draft"));
    // 分流：小邮件整封下载（一次 FETCH 一批）；大邮件走「只取正文 + 内嵌图」
    const partialSlice = work.filter((m) => m.size > MAX_SOURCE_BYTES);
    const wholeSlice = work.filter((m) => m.size <= MAX_SOURCE_BYTES);
    for (const group of batchBySize(wholeSlice, SOURCE_BATCH_BYTES, BACKFILL_CHUNK)) {
      await fetchSources(client, group.uids, async (uid, source) => {
        const meta = pending.get(uid);
        if (!meta) return;
        const r = await ingestMessage(db, dataDir, { accountId, folder, meta, source });
        ingested.push({ messageId: r.messageId, created: r.created });
        pending.delete(uid);
      });
    }
    if (partialSlice.length > 0) {
      for (const r of await ingestPartial(db, dataDir, client, accountId, folder, partialSlice)) {
        ingested.push(r);
      }
      for (const m of partialSlice) pending.delete(m.uid);
    }
    // 服务端没回原文的（超大邮件已排除，这里是异常兜底）：仍要入索引，
    // 否则列表里会凭空少一封，而游标推过去以后再也补不回来。
    // ⚠ 这些邮件没有原文可解析，而元数据那一遍 FETCH **刻意不带 ENVELOPE**（见
    //   imap.ts 的 META_QUERY：真机实测一封 15ms，占满整个元数据遍）——所以这里给
    //   它们单独补一次信封。通常一块里 0~2 封，一条命令就够。
    const missing = work.filter((m) => pending.has(m.uid));
    if (missing.length > 0) {
      const envelopes = await fetchEnvelopes(
        client,
        missing.map((m) => m.uid)
      );
      for (const meta of missing) {
        const r = await ingestMessage(db, dataDir, {
          accountId,
          folder,
          meta: { ...meta, envelope: envelopes.get(meta.uid) },
          source: undefined,
        });
        ingested.push({ messageId: r.messageId, created: r.created });
        pending.delete(meta.uid);
      }
    }
    elapsed += Date.now() - t0;
    done += slice.length;
    if (ingested.length === before && slice.length === 0) break; // 保险：不空转
  }
  return ingested;
}

/** 落库一个文件夹的状态（水位线 / 回填游标 / 进度），`touchFlags` 时刷新 last_flags_sync */
function saveFolder(
  db: Db,
  accountId: string,
  folder: string,
  uidValidity: number,
  lastSeenUid: number,
  backfillUid: number | null,
  backfillTotal: number,
  backfillRemaining: number,
  touchFlags: boolean
): void {
  db.prepare(
    `INSERT INTO folders (account_id, path, uidvalidity, last_seen_uid, last_flags_sync,
                          backfill_uid, backfill_total, backfill_remaining)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id, path) DO UPDATE SET
       uidvalidity = excluded.uidvalidity,
       last_seen_uid = excluded.last_seen_uid,
       last_flags_sync = CASE WHEN ? THEN excluded.last_flags_sync ELSE folders.last_flags_sync END,
       backfill_uid = excluded.backfill_uid,
       backfill_total = excluded.backfill_total,
       backfill_remaining = excluded.backfill_remaining`
  ).run(
    accountId,
    folder,
    uidValidity,
    lastSeenUid,
    new Date().toISOString(),
    backfillUid,
    backfillTotal,
    backfillRemaining,
    touchFlags ? 1 : 0
  );
}

/**
 * 一块历史回填：从 `fromUid` 往下取，吃满条数/字节/时间上限即停。
 * 返回本块处理封数与下一个游标（null = 已回填到底）。
 */
async function backfillChunk(
  db: Db,
  dataDir: string,
  client: ImapFlow,
  accountId: string,
  folder: string,
  fromUid: number
): Promise<{ count: number; nextUid: number | null }> {
  if (fromUid < 1) return { count: 0, nextUid: null };
  const deadline = Date.now() + BACKFILL_BUDGET_MS;
  // UID 区间按「目标条数 × 2」放宽（UID 有洞：删过的邮件不占 UID，区间要跨过去）
  const span = Math.max(64, BACKFILL_CHUNK * 2);
  let lowerBound = Math.max(1, fromUid - span + 1);
  let metas = await listMetaRange(client, folder, lowerBound, fromUid);
  // 整段都是洞（UID 稀疏）时继续往下探，最多探 5 段，避免极端情况下空转
  for (let probe = 0; metas.length === 0 && lowerBound > 1 && probe < 5; probe++) {
    const nextLo = Math.max(1, lowerBound - span);
    metas = await listMetaRange(client, folder, nextLo, lowerBound - 1);
    lowerBound = nextLo;
  }

  if (metas.length === 0) {
    return lowerBound <= 1 ? { count: 0, nextUid: null } : { count: 0, nextUid: lowerBound - 1 };
  }

  // 倒序（最新优先）+ 条数/字节上限：本块吃掉的必定是这一段里最高的连续若干封
  const desc = [...metas].sort((a, b) => b.uid - a.uid);
  const picked: NewMeta[] = [];
  let bytes = 0;
  for (const m of desc) {
    if (picked.length >= BACKFILL_CHUNK) break;
    if (picked.length > 0 && bytes + m.size > BACKFILL_BYTES) break;
    picked.push(m);
    bytes += m.size;
  }

  // 落盘：自适应分批（见 ingestAdaptive），超预算就停在这批——
  // 游标指向**已处理的最低 UID**，没处理的那几封下一块再来
  const ingested = await ingestAdaptive(
    db, dataDir, client, accountId, folder, picked, deadline
  );
  const processed = ingested.length;
  const lowest = picked[processed - 1].uid;
  return { count: processed, nextUid: lowest > 1 ? lowest - 1 : null };
}

export async function syncFolder(
  db: Db,
  dataDir: string,
  client: ImapFlow,
  account: AccountConfig,
  folder: string,
  opts: SyncOptions = {}
): Promise<SyncResult> {
  const mode = opts.mode ?? "full";
  const uidValidity = await openReadOnly(client, folder);
  const state = db
    .prepare(
      `SELECT uidvalidity, last_seen_uid, last_flags_sync, backfill_uid, backfill_total,
              backfill_remaining,
              (SELECT COUNT(*) FROM copies WHERE account_id = ? AND folder = ?) AS local_copies
       FROM folders WHERE account_id = ? AND path = ?`
    )
    .get(account.id, folder, account.id, folder) as SyncFolderState | undefined;

  let lastSeenUid = state?.last_seen_uid ?? 0;
  let backfillUid = state?.backfill_uid ?? null;
  let backfillTotal = state?.backfill_total ?? 0;
  let backfillRemaining = state?.backfill_remaining ?? 0;
  let rebuilt = false;

  if (state && state.uidvalidity !== null && state.uidvalidity !== uidValidity) {
    // UIDVALIDITY 变化：该文件夹索引重来（水位线与回填游标一起归零），孤儿 message 清理。
    // ⚠ 孤儿清理走 pruneOrphanMessages（集合化）：逐封删 FTS 是 O(n²)，一个几千封的
    //   文件夹重建时会卡几十秒（同 deleteAccount 的事故，见 message.ts 的注释）。
    const pruned = db.transaction(() => {
      db.prepare("DELETE FROM copies WHERE account_id = ? AND folder = ?").run(account.id, folder);
      return pruneOrphanMessages(db, { collectEml: true });
    })();
    // 原文文件在事务提交后再删（见 removeEmlFiles 的说明）
    removeEmlFiles(dataDir, pruned.emlPaths);
    lastSeenUid = 0;
    backfillUid = null;
    backfillTotal = 0;
    backfillRemaining = 0;
    rebuilt = true;
  }

  // ---- 自愈：水位线推进过、本地却一封副本都没有（2026-10-08 修）----
  // 这是「账号被删过、`folders` 行残留」留下的**不可能状态**：旧 deleteAccount 只清
  // copies / messages，不清 folders；而账号 id 是从邮箱地址推导的（deriveId），
  // 于是删掉再重加同一个邮箱 = 同一个 id = **继承旧水位线**，服务端那 6711 封全被当成
  // 「早就抓过了」：既不抓、也不回填（`backfill_uid` 为 NULL，底栏当然也没有任何进度），
  // 表现就是「加了账号毫无动静、一封信都不下来」，且没有任何报错。
  // 判据是「水位线 > 0 且本地 0 副本且没有待回填」——本地副本只可能被删账号清掉
  // （服务端删信不会动 copies），正常的空文件夹水位线是 0，故不会误判。
  // 处置：当作从未同步过重来（重新钉水位线 + 从头回填）。deleteAccount 侧已同步修掉
  // 根因（清 folders 行），这里是给已经被污染的库兜底。
  if (state && backfillUid === null && lastSeenUid > 0 && state.local_copies === 0) {
    lastSeenUid = 0;
    backfillTotal = 0;
    backfillRemaining = 0;
  }

  // ---- 首次见到该文件夹（含刚重建）：初始化倒序回填 ----
  // 判据 = 无回填游标且水位线还在 0（水位线为 0 又无游标，只可能是「从未成功同步过」；
  // 空文件夹回填完也是这个态，下一轮再走一遍 exists=0 分支，无副作用）。
  // 先水位线钉到当前最大 UID：新邮件（> 该值）走增量，历史（≤ 该值）走回填。
  if (backfillUid === null && lastSeenUid === 0) {
    // ⚠ imapflow 的 client.mailbox 类型是 `MailboxObject | false`（false = 未打开）
    const mb = client.mailbox || undefined;
    const exists = mb?.exists ?? 0;
    const top = Math.max(0, (mb?.uidNext ?? 1) - 1);
    if (exists > 0 && top > 0) {
      backfillUid = top;
      backfillTotal = exists;
      backfillRemaining = exists;
      lastSeenUid = top;
      // 立刻落库（2026-10-08）：`/health` 的回填进度就看这一行。等本块抓完再写的话，
      // 新账号加进来后的头几秒~几十秒里底栏什么都看不到（用户报「不知道它在不在下载」），
      // 而这正是最需要显示进度的时刻。顺带把水位线也钉住了：这一块中途崩掉/被部署打断，
      // 重启后不会重头再来。
      saveFolder(
        db, account.id, folder, uidValidity, lastSeenUid,
        backfillUid, backfillTotal, backfillRemaining, false
      );
    }
  }

  const fetched: { messageId: string; created: boolean }[] = [];
  let backfilled = 0;

  // ---- 1) 增量（回填期间照跑：先增量、后回填，回填不阻塞新邮件）----
  if (mode === "full") {
    const fresh = await listNewMeta(client, folder, lastSeenUid, INCREMENTAL_MAX);
    // 积压很多（比如账号被停用过一阵）时同样受时间预算约束：水位线逐批落库，
    // 剩下的下一轮接着吃，不把这一轮的账号锁占成几分钟。
    // ⚠ 水位线只能推在**已入库的那一封**上（listNewMeta 升序返回，ingestAdaptive
    //   也按这个顺序吃），超预算提前停时不能跳过没入库的那几封。
    if (fresh.length > 0) {
      const deadline = Date.now() + BACKFILL_BUDGET_MS;
      const done = await ingestAdaptive(db, dataDir, client, account.id, folder, fresh, deadline);
      // 空 messageId = 被跳过的草稿占位（见 ingestAdaptive）：水位线要用它，统计不要
      fetched.push(...done.filter((d) => d.messageId !== ""));
      const top = fresh[done.length - 1]?.uid ?? lastSeenUid;
      if (top > lastSeenUid) lastSeenUid = top;
      saveFolder(
        db, account.id, folder, uidValidity, lastSeenUid,
        backfillUid, backfillTotal, backfillRemaining, false
      );
    }
  }

  // ---- 2) 历史回填：一块 ----
  if (backfillUid !== null) {
    const consumed = await backfillChunk(db, dataDir, client, account.id, folder, backfillUid);
    backfilled = consumed.count;
    if (consumed.nextUid === null) {
      backfillUid = null;
      backfillRemaining = 0;
    } else {
      backfillUid = consumed.nextUid;
      backfillRemaining = Math.max(0, backfillRemaining - consumed.count);
    }
  }

  // ---- 3) 标记回读（纯读取，3.5）----
  // ⚠ 回填期间让路（2026-10-08，见 FLAGS_BACKFILL_INTERVAL_MS）：每个文件夹 ~2s、一轮 6 个
  //   就是 ~12s，而回填期间每 60 秒就有一轮全量——首轮回填时这些标记回读基本没有收益
  //   （回填入库时每封的 flags 已经写进去了），却实打实和回填抢账号锁与连接。
  let flagsUpdated = 0;
  let flagsSynced = false;
  if (mode === "full") {
    const lastFlags = state?.last_flags_sync ? Date.parse(state.last_flags_sync) : 0;
    const throttled =
      hasPendingBackfill(db, account.id) &&
      Date.now() - lastFlags < FLAGS_BACKFILL_INTERVAL_MS;
    if (!throttled) {
      const since = new Date(Date.now() - FLAGS_WINDOW_DAYS * 86_400_000);
      const updateFlags = db.prepare(
        "UPDATE copies SET flags = ? WHERE account_id = ? AND folder = ? AND uid = ? AND flags != ?"
      );
      for (const entry of await listFlagsSince(client, folder, since)) {
        const flags = entry.flags.join(" ");
        flagsUpdated += updateFlags.run(flags, account.id, folder, entry.uid, flags).changes;
      }
      flagsSynced = true;
    }
  }

  saveFolder(
    db, account.id, folder, uidValidity, lastSeenUid,
    backfillUid, backfillTotal, backfillRemaining,
    // ⚠ 只有真的读了才刷新 last_flags_sync：跳过却盖时间戳，下一轮就会以为「刚读过」
    //   而继续跳过（10 分钟的窗口永远打不开）
    mode === "full" && flagsSynced
  );

  return {
    accountId: account.id,
    folder,
    rebuilt,
    fetched: fetched.length + backfilled,
    backfilled,
    backfillRemaining,
    flagsUpdated,
    ingested: fetched,
  };
}

/** 是否还有待回填的文件夹（守护进程据此决定是否启动回填泵） */
export function hasPendingBackfill(db: Db, accountId?: string): boolean {
  const row = (
    accountId
      ? db
          .prepare(
            "SELECT COUNT(*) AS n FROM folders WHERE backfill_uid IS NOT NULL AND account_id = ?"
          )
          .get(accountId)
      : db.prepare("SELECT COUNT(*) AS n FROM folders WHERE backfill_uid IS NOT NULL").get()
  ) as { n: number };
  return row.n > 0;
}

export interface BackfillProgress {
  path: string;
  remaining: number;
  total: number;
}

/** 回填进度（只读；/health 与前端进度显示用） */
export function backfillProgress(db: Db, accountId: string): BackfillProgress[] {
  return db
    .prepare(
      `SELECT path, backfill_remaining AS remaining, backfill_total AS total FROM folders
       WHERE backfill_uid IS NOT NULL AND account_id = ? ORDER BY backfill_remaining DESC`
    )
    .all(accountId) as BackfillProgress[];
}

export async function syncAccount(
  db: Db,
  dataDir: string,
  account: AccountConfig,
  cred: AccountCredential,
  existingClient?: ImapFlow,
  opts: SyncOptions = {}
): Promise<SyncResult[]> {
  // 红线 10：同一账号串行一条连接；IDLE 监听复用已有连接，不开第二条
  const client = existingClient ?? (await connectAccount(account, cred));
  try {
    const results: SyncResult[] = [];
    for (const folder of account.folders) {
      results.push(await syncFolder(db, dataDir, client, account, folder, opts));
    }
    return results;
  } finally {
    if (!existingClient) {
      await client.logout().catch(() => {});
    }
  }
}
