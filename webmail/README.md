# webmaild · 站内 webmail 后端

MAIL-AGENT.md 第八节第 2 步的后端部分（架构见文档 4.6）。独立包、独立进程：正常 webmail 的写操作（任意 `STORE` / `MOVE` / `EXPUNGE` / `APPEND` / SMTP）全部只存在于本包；`mail/` 包保持只读，本包 import 它的纯读取模块。

## 结构

| 文件 | 职责 |
|---|---|
| `src/types.ts` | `WebmailAccount`（共享注册表结构 + SMTP 字段）、`SendInput` 等 |
| `src/config.ts` | 账号注册表与凭据加载（`accounts.json` / `credentials.json`） |
| `src/write.ts` | IMAP 写操作：`setFlags`（`+FLAGS`/`-FLAGS`）、`detectSentFolder` / `detectTrashFolder`（`\Sent` / `\Trash` 探测）、`appendRaw`、`moveUid`、`deleteUid` |
| `src/send.ts` | 发信：MailComposer 构造一次 → SMTP 与 `APPEND` 用同一份字节（红线 6）；先探测「已发送」再发信 |
| `src/render.ts` | HTML 邮件渲染管线：sanitize-html + 远程内容白名单 + cid 重写 + style 里的 url() 剥除（4.4） |
| `src/api.ts` | HTTP API（node:http，绑 `127.0.0.1:9710`）；账号级互斥锁（红线 10：每账号同一时刻一条 IMAP 连接） |
| `src/accounts.ts` | 账号增删（4.11）：`normalizeAccountInput` 纯校验/归一 + `testAccountConnection`（IMAP 登录 + SMTP verify）+ `addAccount` / `deleteAccount`（原子落盘、失败回滚） |
| `src/contacts.ts` | 通讯录 CRUD + 自动收录（4.10）|
| `src/index.ts` | 入口：启动同步一轮 + 60 秒定时轮询 + API 常驻 |

## 数据目录

`WEBMAIL_DATA_DIR`（缺省 `cwd/data/webmail`）：

```
accounts.json      账号注册表 + remoteImageDomains（远程图片白名单域名）
credentials.json   凭据（IMAP + SMTP 同一组口令；chmod 600，勿入库）
webmail.db         SQLite 索引（schema 复用 mail 包）
eml/               原文留存
```

## 命令

```bash
pnpm install --ignore-workspace
pnpm start                        # 常驻（API + 定时同步）
pnpm test                         # 测试（CONTAINER_BIN=podman pnpm test）
pnpm typecheck
```

## 测试（37 条，test/）

集成用例对真实 Dovecot 容器断言，SMTP 侧用 `smtp-server` 起内存接收端：

- **发信**：SMTP 接收端收到的字节与 IMAP「已发送」里留底的字节**逐字节一致**（Message-ID 相同）；找不到「已发送」文件夹时拒发且 SMTP 不发出；非法地址被拒。
- **写操作**：标已读对两个账号的副本**一起写**（服务端 flags 读回验证 + 本地索引同步）；星标往返不触碰 `\Seen`；移动单副本到回收站不影响另一个副本；最后一个副本删除后消息从索引清理。
- **API**：合并视图倒序 + 跨账号副本聚合、账号筛选、**状态 / 方向筛选（unseen / flagged / received / sent，方向口径与前端「已发送」徽章一致，见 src/write.ts 的 `SENT_FOLDER_NAMES`）**、trigram / LIKE 搜索、游标分页、远程图片白名单（剥除 / 保留 / cid 重写 / style url() 剥除）、附件端点、健康检查。
- **通讯录**：CRUD + 邮箱唯一（`COLLATE NOCASE`）、自动收录（按通信次数聚合、排除自身账号与已保存地址）、`suggest` 顺序（已保存在前）、列表发件人名字被通讯录覆盖。
- **账号管理**：校验分支（缺字段 / 邮箱非法 / 端口越界 / id 冲突 409 / folders 全空）、连接失败（密码错 / 不可达端口）**不落盘且进程不挂**、HTTP 400/502/201/DELETE、落盘后 `credentials.json` 为 600 且顶层字段不被覆盖、删除清理副本与孤儿消息、至少保留一个账号 409。

## 实现经验（实测踩过的）

1. **imapflow `messageDelete(range, {uid:true})` = 置 `\Deleted` + `UID EXPUNGE`**（UIDPLUS 时只清指定 UID）；`messageMove` 内置 MOVE 扩展探测与 COPY+EXPUNGE 回退。不要自己拼这两个流程。
2. **mailparser 默认把 cid: 附件转成 data: URI 内嵌进 HTML**——要自己的 cid 重写管线必须传 `keepCidLinks: true`。
3. **sanitize-html 会把 style 重序列化为紧凑形式**（`color: red` → `color:red`），断言样式文本时用紧凑形式。
4. **`smtp-server` 测试接收端两个坑**：缺 `onAuth` 处理器时对 AUTH 直接回 535；默认宣告 STARTTLS 且内置证书已过期，nodemailer 机会性 STARTTLS 会因此失败——测试端加 `hideSTARTTLS: true`。
5. 断言 HTML 里「不存在某 src」时注意 `data-remote-src` 属性名包含子串 `src=`，要用带前导空格的 ` src="` 匹配。
