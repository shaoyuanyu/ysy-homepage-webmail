# ---- webmail 镜像：webmaild（站内邮箱后端；MAIL-AGENT.md 4.6）----
#
# ⚠ 构建上下文 = 仓库根，且必须包含 mail/ 与 webmail/ 两个源目录：
#   1) webmail 运行时直接 import mail/ 的共享模块（db / imap / fetcher / message /
#      search / thread / types）；
#   2) Node 按「引用方所在目录」向上解析依赖——mail/src/* 的 import 从
#      mail/node_modules 解析、webmail/src/* 从 webmail/node_modules 解析，
#      两个依赖树都必须安装（各自 lockfile，--ignore-workspace 独立装）。
# 用法：docker build -f webmail.Dockerfile -t webmail .

# ---- 依赖阶段（better-sqlite3 在 alpine 上需源码编译：python3 + make + g++）----
FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++
RUN corepack enable
WORKDIR /app
COPY webmail/package.json webmail/pnpm-lock.yaml ./webmail/
COPY mail/package.json mail/pnpm-lock.yaml ./mail/
# webmail 全量安装（tsx 在 devDependencies，是运行时启动器）
RUN cd webmail && pnpm install --frozen-lockfile --ignore-workspace
# mail 只装生产依赖（共享模块运行时用到的那部分；AI SDK / mailauth 等仅 mail-agent 需要）
RUN cd mail && pnpm install --frozen-lockfile --prod --ignore-workspace

# ---- 运行阶段 ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# 容器以 uid 1001 运行（与 web 容器一致）；/data 是数据目录的挂载点
RUN addgroup --system --gid 1001 webmaild \
  && adduser --system --uid 1001 --ingroup webmaild webmaild \
  && mkdir -p /data && chown webmaild:webmaild /data

COPY --from=deps --chown=webmaild:webmaild /app/webmail/node_modules ./webmail/node_modules
COPY --from=deps --chown=webmaild:webmaild /app/mail/node_modules ./mail/node_modules
COPY --chown=webmaild:webmaild webmail ./webmail
COPY --chown=webmaild:webmaild mail ./mail

# 数据目录（accounts.json / credentials.json(600) / webmail.db / eml/）：
#   compose 绑定挂载 ./webmail-data:/data（宿主目录需 chown 1001:1001）
ENV WEBMAIL_DATA_DIR=/data
# 容器内监听全部地址：端口不发布到宿主，仅 compose 网络内的 web 可达
ENV WEBMAIL_HOST=0.0.0.0

USER webmaild
EXPOSE 9710
WORKDIR /app/webmail
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
