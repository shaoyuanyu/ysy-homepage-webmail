# CLAUDE.md

本仓库（`ysy-homepage-webmail`）是个人主页的**邮件后端**：`webmail/`（webmaild，站内邮箱 API）+ `mail/`（共享邮件核心库，将来 mail-agent 的宿主）。

## 必读

**邮件系统的完整开发规范、设计决策与经验教训在 MAIL-AGENT.md** —— 它随主仓库 `ysy-homepage-web` 维护（本仓库 README 有链接）。改本仓库代码前先读它；本地开发时它在相邻目录 `../ysy-personal-homepage/MAIL-AGENT.md`（本地目录名可能不同）。

## 结构约定

- 两个子项目**各自独立**：各自的 `package.json` / `pnpm-lock.yaml`，**不是** pnpm workspace。装依赖要 `cd` 进去装。
- `webmail/` 运行时**直接 import** `../mail/src/*.js`（相对路径，跨目录）——两者必须同仓库；Node 按引用方目录解析依赖，两个依赖树都要装。
- 根 `Dockerfile` = webmail 镜像（构建上下文 = 仓库根，COPY `mail/` + `webmail/`）。

## 常用命令

```bash
cd webmail && pnpm test && pnpm typecheck
cd mail    && pnpm test && pnpm typecheck
docker build -t webmail .        # 本地构建镜像
```

## 部署链路（勿改）

代码推送 main → 主仓库部署流水线给本仓库推 `release-v<提交日期>-<短SHA>` 标签（版本号取**本仓库该提交自身的日期**，不是部署日期——没改动时版本号不变，主仓库流水线会直接复用已有镜像、不重建也不重启容器）→ **阿里云 ACR**（镜像仓库 `ysy-homepage-webmail`，内置构建规则构建根 Dockerfile）产出同名版本号镜像 → VPS 上 `~/personal-homepage/deploy.sh` 按版本号拉取、校验入口 Cmd（必含 `tsx`）、重建并做健康探测。回退 = 主仓库流水线 workflow_dispatch 指定旧版本号，或 VPS 上 `bash deploy.sh <web版本> <邮件旧版本>`（不依赖 GitHub 健康）。

⚠ 镜像仓库的构建规则不需要自定义规则：**根 Dockerfile 就是 webmail 的**，ACR 内置规则天然正确（这正是本仓库独立出来的原因）。
