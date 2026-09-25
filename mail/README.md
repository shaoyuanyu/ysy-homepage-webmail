# maild · 邮件抓取与索引

MAIL-AGENT.md 第八节第 1 步的实现。独立包、独立进程：agent 侧的邮件凭据只落在本进程（文档 5.3 第一条）。

**当前边界**：只读。打开邮箱一律 `EXAMINE`，取正文一律 `BODY.PEEK[]`；包内不存在任何 `STORE` / `APPEND` / `EXPUNGE` / `COPY` 调用（文档 3.2 的审查项）。`setFlags` / 发信属后续步骤（受限工具面），届时以独立模块引入并接受审查。

## 结构

| 文件 | 职责 |
|---|---|
| `src/config.ts` | 账号注册表与凭据加载（`accounts.json` / `credentials.json`） |
| `src/db.ts` | SQLite schema：`folders`（增量状态机）/ `messages` / `copies` / `messages_fts`（trigram） |
| `src/imap.ts` | IMAP 读取原语：EXAMINE 打开、增量 meta、PEEK 取原文、FLAGS 回读 |
| `src/message.ts` | MIME 解析与入库：`messages` 按 Message-ID 单份，副本落 `copies`，幂等 |
| `src/fetcher.ts` | 增量同步：UIDVALIDITY 变化重建、大小阈值、标记回读窗口 90 天 |
| `src/idle.ts` | IDLE 监听：exists 事件唤醒、3 分钟兜底轮询、指数退避重连、AbortSignal 停机 |
| `src/search.ts` | 搜索封装：≥3 字符走 trigram `MATCH`，1~2 字符走 `LIKE` 兜底 |
| `src/index.ts` | 入口：`--once` 单轮同步；无参数进入 IDLE 常驻 |

## 数据目录

`MAIL_DATA_DIR`（缺省 `cwd/data/mail`）：

```
accounts.json      账号注册表（id/显示名/地址/服务商/颜色/IMAP 主机端口/文件夹白名单/启用）
credentials.json   凭据（按账号 id 索引；chmod 600，勿入库）
mail.db            SQLite 索引（WAL）
eml/               原文留存（sha1(message_id).eml；超 50MB 只存元数据，MAIL_MAX_SOURCE_BYTES 可调）
```

## 命令

```bash
pnpm install --ignore-workspace   # 独立包安装（better-sqlite3 需源码编译：node-gyp + g++ + python3）
pnpm sync                         # 单轮同步（--once）
pnpm start                        # 常驻：单轮后进入 IDLE 监听
pnpm test                         # 测试（集成用例需要容器：CONTAINER_BIN=podman pnpm test）
pnpm typecheck
```

## 测试（14 条，test/）

集成用例对真实 Dovecot 容器断言，本机用 rootless podman（`CONTAINER_BIN=podman`），CI 用 docker：

- **PEEK 常驻断言（7.1）**：抓取前后服务端 `\Seen` 集合逐封一致——这一步不过，后面都不许走。
- 幂等（重复同步 +0）、增量（新邮件到达入库）、标记回读（服务端置 `\Seen` 同步回本地）。
- UIDVALIDITY 变化后重建该文件夹索引，孤儿 message 一并清理。
- IDLE 唤醒（新邮件 631ms 入库，不等兜底轮询）与优雅停机。
- trigram 模糊搜索 6 条（`test/search.test.ts`）。

容器约定：不挂 maildir 卷（rootless 下 userns 映射会让 dovecot 起不来），投放走 IMAP `APPEND`，重建 UIDVALIDITY 走 `exec rm -rf /srv/mail/<user>`。dovecot 的 UIDVALIDITY 是秒级时间戳，重建后须跨秒再投放。

## 实现经验（都是实测踩过的）

1. **imapflow 流式 `fetch` 未耗尽时，在同一连接上发新命令会死锁**（单 socket 命令串行）。`listNewMeta` / `listFlagsSince` 因此先把结果收集成数组再返回，`fetchSource` 在流外调用。
2. **IMAP `UID n:*` 永远至少命中最后一封**（RFC 3501：`*` 即最大 UID，与 n 无关）——增量必须自行 `uid > lastSeenUid` 过滤，否则每轮重抓最后一封。
3. `connectAccount` 显式 `socketTimeout: 30s`：服务端无响应时 fast-fail，无限挂起是最差的失败模式。
4. SQLite `changes()` 对值不变的 `UPDATE` 也记匹配数——「标记更新」计数加 `flags != ?` 条件才表示真实变化。
