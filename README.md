# ysy-homepage-webmail

个人主页「站内邮箱」的**后端**：webmaild（浏览器端邮箱 API 服务）+ 共享邮件核心库。

## 仓库族

| 仓库 | 内容 |
|---|---|
| [ysy-homepage-web](https://github.com/shaoyuanyu/ysy-homepage-web) | 网站主体（Next.js，含 `/mail` 页面与代理） |
| **ysy-homepage-webmail**（本仓库） | 邮件后端：`webmail/`（webmaild，:9710）+ `mail/`（共享核心库） |
| `ysy-homepage-mail-agent`（规划中） | 邮件 AI agent（只读入口，独立部署） |

- **开发规范与完整设计文档**：见主仓库 [MAIL-AGENT.md](https://github.com/shaoyuanyu/ysy-homepage-web/blob/main/MAIL-AGENT.md)
- 镜像由阿里云 ACR 构建（**根 `Dockerfile`**，构建上下文 = 仓库根）；部署流水线在主仓库，推 `release-v*` 标签到本仓库触发构建。

## 结构

```
Dockerfile     # webmail 镜像（webmaild）。构建上下文必须同时包含 mail/ 与 webmail/
webmail/       # webmaild：站内邮箱的同步与读写 API（IMAP/SMTP + SQLite）
mail/          # 共享邮件核心库（db / imap / fetcher / search / thread）
               #   webmail 运行时直接 import 其模块；也是将来 mail-agent 的宿主
```

## 开发

两个子项目**各自独立**（各自的 `package.json` / `pnpm-lock.yaml`，不是 workspace）：

```bash
cd webmail && pnpm install && pnpm test && pnpm typecheck
cd mail    && pnpm install && pnpm test && pnpm typecheck
```

## 构建镜像

```bash
docker build -t webmail .
```

⚠ 运行时数据（`accounts.json` / `credentials.json` / `webmail.db` / `eml/`）经
`WEBMAIL_DATA_DIR`（默认 `/data`）挂载，不在镜像内。
