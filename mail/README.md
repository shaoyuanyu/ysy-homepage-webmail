# maild · 邮件抓取与索引 + 受限工具面

MAIL-AGENT.md 第八节第 1、3 步的实现。独立包、独立进程：agent 侧的邮件凭据只落在本进程（文档 5.3 第一条）。

**边界**：对外部数据源与 `me@` 只读——打开邮箱一律 `EXAMINE`，取正文一律 `BODY.PEEK[]`；包内写调用只有两个落点：`flags.ts`（唯一 `STORE`，3.5）与 `send.ts`（唯一 `APPEND`/SMTP，只写 `agent@` 自己的「已发送」，3.3/3.4）。`test/audit.test.ts` 把这条审查项机器化（扫源码断言落点唯一），删光实现也会红（防假绿）。

## 结构

| 文件 | 职责 |
|---|---|
| `src/config.ts` | 账号注册表与凭据加载（`accounts.json` / `credentials.json` / CalDAV 段） |
| `src/db.ts` | SQLite schema：`folders`（增量状态机）/ `messages` / `copies` / `messages_fts`（trigram）；`resolveMessageKey`（工具面 messageId 宽容归一） |
| `src/imap.ts` | IMAP 读取原语：EXAMINE 打开、增量 meta、PEEK 取原文、FLAGS 回读 |
| `src/message.ts` | MIME 解析与入库：`messages` 按 Message-ID 单份（库键 `mid:<裸id小写>`），副本落 `copies`，幂等 |
| `src/fetcher.ts` | 增量同步：UIDVALIDITY 变化重建、大小阈值、标记回读窗口 90 天 |
| `src/idle.ts` | IDLE 监听：exists 事件唤醒、3 分钟兜底轮询、指数退避重连、AbortSignal 停机 |
| `src/search.ts` | 搜索封装：≥3 字符走 trigram `MATCH`，1~2 字符走 `LIKE` 兜底 |
| `src/ledger.ts` | `agent.db`：`tool_ledger`（只追加台账，工具层写、不可绕过）+ `pending_sends`（发信闸门队列，含 MIME 字节） |
| `src/flags.ts` | **全包唯一 STORE**（3.5）：只碰 `\Seen`/`\Flagged`、`+FLAGS`/`-FLAGS`、`uid: true`、索引外消息拒绝、多副本一起写、前值/后值落台账；账号级互斥锁（`withAccountLock`） |
| `src/send.ts` | `send_as_agent` + 发信闸门（3.7）：白名单直发，白名单外进 `pending_sends`；确认/丢弃走 HTTP 端点（非 MCP 工具）；MailComposer 构造一次 MIME → SMTP 与 `APPEND` 同一份字节（红线 6）；`\Sent` 探测不到拒发（红线 5） |
| `src/events.ts` | `create_event`：写主站 CalDAV `agent-schedule` 集合（Radicale MKCOL/PUT，ICS 手工构造 + RFC 5545 转义折行） |
| `src/reader.ts` | `read_message` / `get_attachment`：本地索引 + `.eml` 组装详情（eml_path 相对 dataDir，读取必须拼） |
| `src/tools.ts` | 8 个固定工具的定义与 `callTool` 分发（每次调用先落台账，成功/失败都记） |
| `src/mcp.ts` | 工具面 HTTP 服务：`POST /mcp`（MCP streamable HTTP，无状态）+ `GET /health` `/ledger` `/pending-sends` + `POST /pending-sends/:id/confirm|discard`，绑 `127.0.0.1:9711`（`MAILD_TOOLS_PORT` 可调） |
| `src/index.ts` | 入口：`--once` 单轮同步；无参数进入 IDLE 常驻并挂起工具面 |

## 数据目录

`MAIL_DATA_DIR`（缺省 `cwd/data/mail`）：

```
accounts.json      账号注册表（id/显示名/地址/服务商/颜色/IMAP 主机端口/文件夹白名单/启用；
                   agent 账号另有 isAgent + smtpHost/smtpPort/smtpSecure；顶层 caldav 段供 create_event）
credentials.json   凭据（按账号 id 索引；caldav 键存 Radicale 用户名密码；chmod 600，勿入库）
mail.db            SQLite 索引（WAL）——纯原始邮件索引
agent.db           工具层/模型产物库（台账 + 待确认队列 + tasks 任务队列 + judgment/reasoning）
eml/               原文留存（sha1(message_id).eml；超 50MB 只存元数据，MAIL_MAX_SOURCE_BYTES 可调）
```

## 受限工具面（第 3 步）

agent 只能调这 8 个工具——**没有删除、移动、EXPUNGE 的函数**，「不能删邮件」靠没有这个函数而不是提示词：

`list_accounts`（不含凭据）/ `search_messages`（trigram 模糊）/ `read_message`（正文截断 5 万字符）/ `get_attachment`（>10MB 拒绝）/ `set_flags`（3.5 全部约束）/ `send_as_agent`（3.7 闸门）/ `get_ledger`（台账只读）/ `create_event`（CalDAV）

- **messageId 宽容归一**：库键（`mid:…`/`auto:…`）直通；裸 Message-ID（`<x@y>` 或 `x@y`，大小写不敏感）自动补 `mid:` 前缀；查不到即拒绝（3.5 的「只接受索引里已存在的值」在入口处落实）。
- **写操作的 IMAP 连接策略**：不碰抓取器的 IDLE 连接；`set_flags` 与 `APPEND` 各开短时第二条连接，账号级互斥、用完即断（红线 10 的补充，5.3）。
- **确认不 exposed 成 MCP 工具**：`/pending-sends/:id/confirm|discard` 只在 HTTP 端点上，agent 不能自己给自己的外发开闸（3.7）。
- **UID 错位防护**：`set_flags` 写每个副本前，先取服务端 envelope 核对 UID 仍指向同一 Message-ID，错位即跳过（等下轮同步重建）。

## agent worker 池与产物（第 4 步）

- **worker 池在 maild 进程内**（并发缺省 3，`MAILD_WORKER_CONCURRENCY` 可调），但**工具调用一律经 MCP client 走 HTTP 自连**（`127.0.0.1:9711`）：worker 侧模块（`worker/judge/model/queue`）不 import 凭据/IMAP/SMTP，audit 测试扫 import 清单锁定，将来拆独立容器零代码改动。
- **任务队列 = `agent.db` 的 `tasks` 表**：原子领取靠一条 `UPDATE ... WHERE id = (SELECT ... ORDER BY priority DESC, id LIMIT 1) RETURNING`（better-sqlite3 同步 API 单进程天然串行）；失败指数退避 `run_after`（2^attempts 分钟），3 次后标 `failed`。
- **触发接线（`trigger.ts`）**：入库新邮件 → 指令认证 → 投任务。**只处理 `created = true` 的邮件**（多副本重复入库不重复投，指令邮件尤其不能执行两次）。
- **指令认证（`auth.ts`，3.6）**：From 在白名单（注册表里除 agent 外的账号地址）+ SPF/DKIM **双双通过**（mailauth 自验，`trustReceived: true` 从 Received 链取第一跳验 SPF），不依赖服务商的 `Authentication-Results`；认证异常一律按普通邮件处理（宁可误判为 judge）。`resolver` 可注入 DNS 解析器，测试离线可跑。
- **judge**：`generateObject` + zod → `verdict(important|normal|noise)` + `labels[]` + `confidence` + 一句话说明；`judgment` 一封信一行（重判覆盖），`reasoning` 一次处理一行（只追加）；labels 含 `event` 时经 MCP `create_event` 写日历（写失败不影响判定落库）。
- **command**：指令正文 → `generateText` + MCP tools + `stopWhen: stepCountIs(10)` 多轮工具调用 → 回执经 `send_as_agent` 发给指令来源（白名单内直发）。
- **report**：每日 21:00（`model.reportHour` 可配）汇总当日判定分布 + 重要清单 + 待确认队列提醒，发 `me@`。
- **模型配置**：`accounts.json` 顶层 `model` 段（`baseURL`/`model`/`reportHour`），apiKey 在 `credentials.json` 的 `model` 键；provider 一律 `@ai-sdk/openai-compatible`（DeepSeek/Kimi/GLM 同端点形态）。**未配置 model 段时 worker 池不启动，任务照常入库，配置后重启即消费**。
- **模型客户端可注入**：worker/judge 只认 `LanguageModel` 实例——生产 `createModel()` 走 AI SDK，测试注入 `MockLanguageModel`，模型层测试不依赖外部 API。
- **prompt_version 是代码常量**（`JUDGE_PROMPT_VERSION` 等），改提示词时递增，随判定落库（5.2「当时为什么这么判」可答）。

## 命令

```bash
pnpm install --ignore-workspace   # 独立包安装（better-sqlite3 需源码编译：node-gyp + g++ + python3）
pnpm sync                         # 单轮同步（--once）
pnpm start                        # 常驻：单轮后进入 IDLE 监听 + 工具面（127.0.0.1:9711）
pnpm test                         # 测试（集成用例需要容器：CONTAINER_BIN=podman pnpm test）
pnpm typecheck
```

## 测试（69 条，test/）

集成用例对真实 Dovecot 容器断言，本机用 rootless podman（`CONTAINER_BIN=podman`），CI 用 docker：

- **PEEK 常驻断言（7.1）**：抓取前后服务端 `\Seen` 集合逐封一致——这一步不过，后面都不许走。
- 幂等（重复同步 +0）、增量（新邮件到达入库）、标记回读（服务端置 `\Seen` 同步回本地）。
- UIDVALIDITY 变化后重建该文件夹索引，孤儿 message 一并清理。
- IDLE 唤醒（新邮件 631ms 入库，不等兜底轮询）与优雅停机。
- trigram 模糊搜索 6 条（`test/search.test.ts`）。
- **audit（5 条）**：源码扫描——STORE 只在 `flags.ts`（且无整体替换语义）、APPEND/SMTP 只在 `send.ts`、全包无 EXPUNGE/MOVE/DELETE、`flags.ts` 之外的 `mailboxOpen` 一律 readOnly、**worker 侧模块不 import 凭据/IMAP/SMTP/工具面服务端（5.3）**。
- **flags（4 条）**：多副本一起写、前值/后值落台账、`\Answered` 不受影响、索引外消息与空 change 拒绝。
- **send（7 条）**：白名单直发且 SMTP 与留底字节一致；白名单外进队列、确认原样发出、丢弃永不发出、重复处理拒绝；cc 外发同样触发闸门；找不到「已发送」拒发且 SMTP 不发出。
- **events（6 条）**：ICS 构造（UTC 化、转义、缺省 end）、MKCOL 建集合路径、PUT 失败落失败台账。
- **tools（10 条）**：MCP `tools/list` 恰好 8 个工具、无凭据字段泄漏、search→read 链路、宽容归一、失败调用落台账、`/ledger` `/pending-sends` `/health` 形状、confirm 对不存在 id 的报错、未知端点 404。
- **auth（7 条）**：白名单不含 agent 自己；SPF/DKIM 双过才是指令；From 不在白名单/SPF 伪造/缺 DKIM/签名后篡改正文都不是指令；DNS 全灭按普通邮件处理。
- **queue（5 条）**：领取顺序 command > report > judge、`run_after` 未到期不领、领取置 running 且 attempts+1、失败退避重投三次后 failed、计数汇总。
- **judge（3 条）**：结构化判定 + 推理文本 + token 数；模型不给推理时 reasoningText 为 null（两种文本分开存）；judgment 重判覆盖、reasoning 只追加。
- **model（4 条）**：model 段 + apiKey 齐备才返回配置、reportHour 缺省 21、baseURL 尾斜杠归一、`createModel` 不发请求。
- **worker（4 条，真实 Dovecot + MCP 自连 + MockLanguageModel）**：judge 全链路（read_message 经 MCP → judgment/reasoning 落库 + 台账）、judge 出 event 写 CalDAV、command 多轮工具调用 + 回执发给指令来源、report 汇总 + 待确认提醒发 reportTo。

容器约定：不挂 maildir 卷（rootless 下 userns 映射会让 dovecot 起不来），投放走 IMAP `APPEND`，重建 UIDVALIDITY 走 `exec rm -rf /srv/mail/<user>`。dovecot 的 UIDVALIDITY 是秒级时间戳，重建后须跨秒再投放。发信用例需要 `Sent` 的 special_use 标志位（`startDovecot(name, { specialUse: true })`）。SMTP 接收端复用 `webmail/test/smtp-sink.ts`（smtp-server 内存桩）。**宿主端口必须预先抢占固定（`pickFreePort`），勿用 `-p 127.0.0.1::143` 的随机分配**——docker 在 restart 时会为宿主端口 0 的映射重新随机分配（podman 不会），UIDVALIDITY 用例 restart 后拿着旧端口必 ECONNREFUSED（第 4 步实测踩中，白等 90s waitReady 超时）。

## 实现经验（都是实测踩过的）

1. **imapflow 流式 `fetch` 未耗尽时，在同一连接上发新命令会死锁**（单 socket 命令串行）。`listNewMeta` / `listFlagsSince` 因此先把结果收集成数组再返回，`fetchSource` 在流外调用。
2. **IMAP `UID n:*` 永远至少命中最后一封**（RFC 3501：`*` 即最大 UID，与 n 无关）——增量必须自行 `uid > lastSeenUid` 过滤，否则每轮重抓最后一封。
3. `connectAccount` 显式 `socketTimeout: 30s`：服务端无响应时 fast-fail，无限挂起是最差的失败模式。
4. SQLite `changes()` 对值不变的 `UPDATE` 也记匹配数——「标记更新」计数加 `flags != ?` 条件才表示真实变化。
5. **库键 ≠ envelope 的 Message-ID**：`messages.message_id` 是 `mid:<裸id小写>`（去尖括号）；工具面收到的 messageId 必须经 `resolveMessageKey` 归一，`set_flags` 核对服务端 envelope 时两边都要先归一裸形态再比（第 3 步实测踩中：直查裸 id 永远落空）。
6. **eml_path 是相对 dataDir 的路径**，读原文必须 `join(dataDir, row.eml_path)`——直接 `readFileSync(eml_path)` 依赖进程 cwd，工具面与同步进程 cwd 不同就 ENOENT。
7. Dovecot 会给新投递的邮件带会话级 `\Recent` 标记——断言 flags 时只关心 `\Seen`/`\Flagged` 的有无，别逐字比对。
