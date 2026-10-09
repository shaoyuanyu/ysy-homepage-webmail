import { ImapFlow } from "imapflow";
import type { AccountConfig, AccountCredential } from "./types.js";

export async function connectAccount(
  account: AccountConfig,
  cred: AccountCredential
): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: { user: cred.username, pass: cred.password },
    logger: false,
    // 显式超时：服务端无响应时 fast-fail，而非无限挂起
    socketTimeout: 30_000,
  });
  // ⚠ 必须自己挂一个 error 监听（2026-10-07 补）：连接失败 / 超时后 imapflow 仍可能
  // 异步发 'error'，EventEmitter 上没有监听器的 'error' 会抛成未捕获异常、把整个
  // webmaild / mailagentd 进程打挂（accounts.ts 的 testAccountConnection 早就这么做，
  // 这里是漏的）。真正的失败仍由 connect() 的 reject 与后续命令的 reject 暴露。
  // ⚠ 反向验证记录：把本行注释掉后 robustness 用例（ECONNREFUSED 立即失败）仍全绿——
  //   「连接被拒」这条路 imapflow 不补发 error；本行防的是**已建连之后**的异步错误
  //   （socketTimeout / 服务端掐断），与 accounts.test.ts 那条回归同源。
  client.on("error", () => {});
  await client.connect();
  return client;
}

export interface EnvelopeInfo {
  date?: Date;
  subject?: string;
  from?: { name?: string; address?: string }[];
  to?: { name?: string; address?: string }[];
  cc?: { name?: string; address?: string }[];
  messageId?: string;
}

export interface NewMeta {
  uid: number;
  flags: string[];
  internalDate: Date | null;
  size: number;
  envelope?: EnvelopeInfo;
}

/** imapflow 的 FETCH 结果 → 本包的 NewMeta（同一口径，避免两处字段解释漂移） */
function toNewMeta(msg: {
  uid: number;
  flags?: Set<string>;
  internalDate?: Date | string;
  size?: number;
  envelope?: unknown;
}): NewMeta {
  return {
    uid: msg.uid,
    flags: msg.flags ? [...msg.flags] : [],
    internalDate: msg.internalDate ? new Date(msg.internalDate) : null,
    size: msg.size ?? 0,
    envelope: msg.envelope as EnvelopeInfo | undefined,
  };
}

/**
 * 元数据 FETCH 要的字段（增量与按 UID 区间取元数据共用同一集合）。
 *
 * ⚠ **刻意不要 `envelope`**（2026-10-08 实测，真机 QQ 邮箱，50 封一批）：
 *
 * | 取哪些字段 | 50 封耗时 |
 * |---|---|
 * | `envelope`（单独） | **616~860ms**（≈15ms/封，整个元数据遍 95% 的时间在这） |
 * | `flags + internalDate + size` | **30~41ms**（≈0.7ms/封） |
 *
 * 而按 UID 区间取元数据时**故意多取一倍**（区间要跨过 UID 洞，见 fetcher.ts 的
 * `backfillChunk`），于是一块 400 封的元数据要 6 秒——比真正下载原文还贵。
 * 头部信息（from/to/subject/date/messageId）本来就要从**原文**里解析（`simpleParser`），
 * 原文反正要下载，没必要再让服务端为每封重新生成一遍 ENVELOPE。
 * 只有「只存元数据、不下载原文」的超大邮件（红线 12）才需要单独补一次信封
 * ——`fetchEnvelopes()`，通常一块里 0~2 封。
 */
const META_QUERY = {
  uid: true,
  flags: true,
  internalDate: true,
  size: true,
};

/** 需要信封的那一次（超大邮件：没有原文可解析） */
const ENVELOPE_QUERY = { uid: true, envelope: true };

/**
 * 按需取信封（只给「拿不到原文」的少数邮件用，见 META_QUERY 的说明）。
 * ⚠ 只在 fetch 流耗尽后调用（红线 16）。
 */
export async function fetchEnvelopes(
  client: ImapFlow,
  uids: number[]
): Promise<Map<number, EnvelopeInfo>> {
  const out = new Map<number, EnvelopeInfo>();
  if (uids.length === 0) return out;
  for await (const msg of client.fetch(uids, ENVELOPE_QUERY, { uid: true })) {
    if (msg.envelope) out.set(msg.uid, msg.envelope as EnvelopeInfo);
  }
  return out;
}

/**
 * 打开文件夹一律 readOnly → EXAMINE，永不 SELECT（MAIL-AGENT.md 3.2）。
 *
 * ⚠ **已经开着的就是它就别再开一遍**（2026-10-08）：imapflow 的 `mailboxOpen` 每次都真的发一条
 * EXAMINE（imapflow 不做「已打开就跳过」的判断），而回填路径上取元数据、每一批取原文
 * 都会走到这里——一小块 80 封里能发出近十条重复的 EXAMINE，每条 20~220ms，账号锁的
 * 时间就这么被吃掉（真机实测）。判据直接用 imapflow 自己维护的连接状态
 * （`client.mailbox.path`），所以连接换了、被别人开了别的文件夹都会自动重新打开——
 * 不会出现「以为开着、其实取的是另一个文件夹」。
 */
export async function openReadOnly(client: ImapFlow, folder: string): Promise<number> {
  const open = client.mailbox;
  if (open && open.path === folder) return Number(open.uidValidity);
  await client.mailboxOpen(folder, { readOnly: true });
  const mb = client.mailbox;
  if (!mb) throw new Error(`mailboxOpen 后无 mailbox 状态：${folder}`);
  return Number(mb.uidValidity);
}

/**
 * 列出 lastSeenUid 之后的新邮件元数据（envelope 级，不含正文）。
 * 注意必须先收集完再返回：fetch 流未耗尽时在同一连接上发新命令会死锁。
 *
 * `limit`：一次最多取多少封（缺省不限制）。给 `limit` 时**取最旧的若干封**
 * （UID 升序前 N 封）——水位线是单调推进的，必须按升序一段一段吃，
 * 不能跳着吃（否则 last_seen_uid 推进后中间那批永远抓不到）。
 */
export async function listNewMeta(
  client: ImapFlow,
  folder: string,
  lastSeenUid: number,
  limit?: number
): Promise<NewMeta[]> {
  await openReadOnly(client, folder);
  // RFC 3501：UID n:* 永远至少命中最后一封（即使 n 大于最大 UID），必须自行过滤
  const uids = ((await client.search({ uid: `${lastSeenUid + 1}:*` }, { uid: true })) || []).filter(
    (u) => u > lastSeenUid
  );
  if (uids.length === 0) return [];
  // search 结果按 UID 升序（RFC 3501 不保证顺序，显式排序以免水位线跳空）
  const picked = limit && uids.length > limit ? uids.sort((a, b) => a - b).slice(0, limit) : uids;
  const out: NewMeta[] = [];
  for await (const msg of client.fetch(picked, META_QUERY, { uid: true })) {
    out.push(toNewMeta(msg));
  }
  return out;
}

/**
 * 按 UID 区间取元数据（历史回填用，信封级、不含正文）。
 * 与 `listNewMeta` 的差别：不回看水位线，直接给一段 UID 范围——回填是**倒序**推进的，
 * 每块只关心「游标往下这一段」。
 *
 * 返回按 UID 升序；区间里没有邮件（UID 有洞）时返回空数组。
 */
export async function listMetaRange(
  client: ImapFlow,
  folder: string,
  fromUid: number,
  toUid: number
): Promise<NewMeta[]> {
  await openReadOnly(client, folder);
  if (toUid < fromUid || toUid < 1) return [];
  const lo = Math.max(1, fromUid);
  const out: NewMeta[] = [];
  for await (const msg of client.fetch(`${lo}:${toUid}`, META_QUERY, { uid: true })) {
    out.push(toNewMeta(msg));
  }
  return out.sort((a, b) => a.uid - b.uid);
}

/**
 * 批量取多封邮件的完整原文（一次 FETCH 命令带回一批）——**首轮抓取的主要提速点**。
 *
 * 旧实现逐封 `fetchOne`：6500 封就是 6500 次 IMAP 往返（实测 ~8 封/秒）。
 * 这里一次命令取一批，服务端流式回吐，调用方逐封消费。
 * ⚠ 仍然只走 `BODY.PEEK[]`（imapflow 的 source 语义，见 fetchSource），不置 \Seen。
 * ⚠ 必须把流消费完才返回：fetch 流未耗尽时在同一连接上发新命令会死锁（红线 16）。
 *
 * `onMessage` 里可以做异步落盘（会形成背压，socket 不会被灌爆）；抛错则中断整批，
 * 由调用方决定游标停在哪（调用方只在整批成功后才推游标）。
 */
export async function fetchSources(
  client: ImapFlow,
  uids: number[],
  onMessage: (uid: number, source: Buffer) => Promise<void>
): Promise<void> {
  if (uids.length === 0) return;
  for await (const msg of client.fetch(uids, { uid: true, source: true }, { uid: true })) {
    if (!msg.source) continue;
    await onMessage(msg.uid, msg.source as Buffer);
  }
}

/**
 * 取单封邮件完整原文。
 * imapflow 2.x 的 source 抓取走 BODY.PEEK[]（commands/fetch.js 注释明确：
 * "PEEK avoids marking messages as \Seen"），且此处另有常驻行为测试兜底（7.1）。
 */
/**
 * MIME 部件叶子（BODYSTRUCTURE 拍平后的一个「可单独 FETCH 的部件」）。
 * ⚠ 顺序 = 深度优先遍历顺序 = **mailparser `parsed.attachments` 的顺序**——
 * 「按需取附件」的序号必须与整封解析出来的序号一致，否则同一封邮件在「只下了正文」
 * 与「补取过整封」两种状态下，点第 2 个附件会拿到不同的文件（2026-10-08，见
 * partial-fetch.test.ts 的序号一致性断言）。
 */
export interface PartLeaf {
  /** IMAP 部件编号（`1` / `2` / `1.2`），单部件 FETCH 用 */
  part: string;
  /** 小写 `type/subtype` */
  type: string;
  /** 传输编码（base64 / quoted-printable / 7bit…），重建 MIME 时要原样带上 */
  encoding: string;
  /** 部件字节数（编码后） */
  size: number;
  /** Content-ID（内嵌图用，形如 `<abc@x>`） */
  id: string | null;
  /** Content-Disposition（`attachment` / `inline` / null） */
  disposition: string | null;
  /** 文件名（优先 disposition 的 filename，退化到 Content-Type 的 name） */
  filename: string | null;
  /** Content-Type 参数（charset 等），重建时会写回 */
  parameters: Record<string, string>;
}

/** imapflow 的 BODYSTRUCTURE 节点（只声明用到的字段）；mime.ts 的剪枝也用它 */
export interface StructureNode {
  part?: string;
  type?: string;
  subtype?: string;
  encoding?: string;
  size?: number;
  id?: string;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  parameters?: Record<string, string>;
  childNodes?: StructureNode[];
}

/**
 * 深度优先拍平 BODYSTRUCTURE（顺序 = 部件在邮件里出现的顺序）。
 *
 * ⚠ **带 `childNodes` 的是容器（multipart/*），不是内容部件**——它们**也有 `part` 编号**
 *   （真机 QQ：`multipart/mixed` 里嵌 `multipart/alternative`，后者 `part: "1"`），
 *   如果当成叶子就会在附件清单里多出「attachment-0(multipart/alternative, 0 字节)」这种
 *   幻影项，并把**后面所有附件的序号整体推错**（mailparser 的 `parsed.attachments` 里
 *   没有容器）。2026-10-08 真机探测抓到，加了嵌套 fixture 的用例锁住。
 */
export function flattenStructure(node: StructureNode | undefined): PartLeaf[] {
  if (!node) return [];
  const out: PartLeaf[] = [];
  for (const child of node.childNodes ?? []) out.push(...flattenStructure(child));
  const isContainer = (node.childNodes ?? []).length > 0;
  if (node.part && !isContainer) {
    // ⚠ imapflow 的 BODYSTRUCTURE 里 `type` **已经是合并好的** `text/plain`（`subtype` 为空），
    //   而原始 IMAP 结构是分开的 `text` + `plain`——两种形态都要吃下（2026-10-08 实测踩坑：
    //   直接拼 `${type}/${subtype}` 会得到 `text/plain/`，导致一个部件都认不出来、整封回退）
    const rawType = (node.type ?? "").toLowerCase().replace(/\/+$/, "");
    const type = rawType.includes("/")
      ? rawType
      : `${rawType}/${(node.subtype ?? "").toLowerCase()}`.replace(/\/+$/, "");
    out.push({
      part: node.part,
      type,
      encoding: (node.encoding ?? "7bit").toLowerCase(),
      size: node.size ?? 0,
      id: node.id ?? null,
      disposition: node.disposition ? node.disposition.toLowerCase() : null,
      filename: node.dispositionParameters?.filename ?? node.parameters?.name ?? null,
      parameters: node.parameters ?? {},
    });
  }
  return out;
}

/**
 * 批量取 MIME 结构（一次 FETCH 命令）。⚠ 真机 QQ 实测 **~75~97ms/封**——比取原文本身
 * （37ms/封）还贵，所以**只能对「大到可能藏大附件」的邮件用**（500KB 门控，见 fetcher.ts），
 * 不能每封都读。
 */
export async function fetchStructures(
  client: ImapFlow,
  uids: number[]
): Promise<Map<number, StructureNode>> {
  const out = new Map<number, StructureNode>();
  if (uids.length === 0) return out;
  for await (const msg of client.fetch(uids, { uid: true, bodyStructure: true }, { uid: true })) {
    const node = (msg as { bodyStructure?: StructureNode }).bodyStructure;
    if (node) out.set(msg.uid, node);
  }
  return out;
}

/**
 * 批量取「顶层邮件头 + 指定部件的内容」（一次 FETCH 命令）。
 * `partIds` 对**这一批里每一封**都生效，所以调用方必须先把「要保留的部件编号集合」
 * 相同的邮件分到一组（`partSignature`），否则会取到不存在的部件号。
 */
export async function fetchParts(
  client: ImapFlow,
  uids: number[],
  partIds: string[]
): Promise<Map<number, { headers: Buffer; parts: Map<string, Buffer> }>> {
  const out = new Map<number, { headers: Buffer; parts: Map<string, Buffer> }>();
  if (uids.length === 0) return out;
  const query = { uid: true as const, headers: true as const, bodyParts: partIds };
  for await (const msg of client.fetch(uids, query, { uid: true })) {
    const m = msg as { headers?: Buffer; bodyParts?: Map<string, Buffer> };
    out.set(msg.uid, { headers: m.headers ?? Buffer.alloc(0), parts: m.bodyParts ?? new Map() });
  }
  return out;
}

/** 按需取**单个部件**（附件点击时才走这条；PEEK，不改任何标记） */
export async function fetchPartBody(
  client: ImapFlow,
  uid: number,
  partId: string
): Promise<Buffer | null> {
  const msg = await client.fetchOne(String(uid), { uid: true, bodyParts: [partId] }, { uid: true });
  if (!msg) return null;
  const parts = (msg as { bodyParts?: Map<string, Buffer> }).bodyParts;
  if (!parts) return null;
  return parts.get(partId) ?? null;
}

/** 一组部件编号的签名（顺序无关）——用来把「保留哪些部件」相同的邮件并成一条 FETCH */
export function partSignature(partIds: string[]): string {
  return [...partIds].sort().join(",");
}

export async function fetchSource(client: ImapFlow, uid: number): Promise<Buffer | null> {
  const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
  if (!msg || !msg.source) return null;
  return msg.source as Buffer;
}

export interface FlagEntry {
  uid: number;
  flags: string[];
}

/** 标记回读：拉取 since 之后邮件的 FLAGS（纯读取，3.5）。同样先收集完再返回 */
export async function listFlagsSince(
  client: ImapFlow,
  folder: string,
  since: Date
): Promise<FlagEntry[]> {
  await openReadOnly(client, folder);
  const uids = (await client.search({ since }, { uid: true })) || [];
  if (uids.length === 0) return [];
  const out: FlagEntry[] = [];
  for await (const msg of client.fetch(uids, { uid: true, flags: true }, { uid: true })) {
    out.push({ uid: msg.uid, flags: msg.flags ? [...msg.flags] : [] });
  }
  return out;
}
