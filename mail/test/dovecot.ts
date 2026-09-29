import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ImapFlow } from "imapflow";

/** 本机用 podman（rootless）；CI 或 VPS 上用 docker。rootless 下容器 root 即宿主当前用户，maildir 不挂卷、由容器自管 */
const CONTAINER_BIN = process.env.CONTAINER_BIN ?? "docker";
const IMAGE = process.env.DOVECOT_IMAGE ?? "docker.io/dovecot/dovecot:2.3.21";

const here = dirname(fileURLToPath(import.meta.url));
export const workRoot = join(here, "..", ".test-data");
export const fixturesDir = join(here, "fixtures", "eml");

const DOVECOT_CONF = `protocols = imap
listen = *
ssl = no
disable_plaintext_auth = no
auth_mechanisms = plain login
mail_location = maildir:/srv/mail/%u
mail_privileged_group = mail
namespace inbox {
  inbox = yes
}
passdb {
  driver = passwd-file
  args = /etc/dovecot/users
}
userdb {
  driver = static
  args = uid=1000 gid=1000 home=/srv/mail/%u
}
log_path = /dev/stderr
`;

/** Sent 带 special_use 标志位（RFC 6154），供发信留底的探测逻辑走主路径 */
const SPECIAL_USE_BLOCK = `  mailbox Sent {
    special_use = \\Sent
    auto = create
  }
`;

export interface DovecotHandle {
  container: string;
  host: string;
  port: number;
  /** dovecot 工作目录（配置） */
  dir: string;
  restart(): void;
  cleanup(): void;
}

/** 预先抢占一个空闲宿主端口：docker restart 会给「宿主端口 0」的映射重新随机分配（podman 不会），
 *  固定端口后 UIDVALIDITY 用例的 restart 才能在两种运行时下都保持端口不变 */
function pickFreePort(): number {
  // net.listen 是异步的而本函数需同步返回，借子进程同步取一个空闲端口（仅测试 harness 用）
  const out = execFileSync(process.execPath, [
    "-e",
    "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})",
  ], { encoding: "utf8" });
  const port = Number(out.trim());
  if (!Number.isInteger(port) || port <= 0) throw new Error(`无法分配空闲端口：${out}`);
  return port;
}

export function startDovecot(suffix: string, opts: { specialUse?: boolean } = {}): DovecotHandle {
  const name = `maild-test-${suffix}-${process.pid}`;
  execSync(`${CONTAINER_BIN} rm -f ${name} >/dev/null 2>&1 || true`);

  const dir = join(workRoot, `dovecot-${suffix}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const conf = opts.specialUse
    ? DOVECOT_CONF.replace("  inbox = yes\n", `  inbox = yes\n${SPECIAL_USE_BLOCK}`)
    : DOVECOT_CONF;
  writeFileSync(join(dir, "dovecot.conf"), conf);
  writeFileSync(join(dir, "users"), "test:{PLAIN}test::::::\n");

  const args = [
    "run",
    "-d",
    "--name",
    name,
    "-v",
    `${dir}/dovecot.conf:/etc/dovecot/dovecot.conf:Z`,
    "-v",
    `${dir}/users:/etc/dovecot/users:Z`,
    "-p",
    `127.0.0.1:${pickFreePort()}:143`,
  ];
  args.push(IMAGE);
  execFileSync(CONTAINER_BIN, args, { stdio: "pipe" });

  const out = execFileSync(CONTAINER_BIN, ["port", name, "143"], { encoding: "utf8" });
  const port = Number(out.trim().split(":").pop());
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`无法解析容器端口映射：${out}`);
  }

  return {
    container: name,
    host: "127.0.0.1",
    port,
    dir,
    restart() {
      execFileSync(CONTAINER_BIN, ["restart", name]);
    },
    cleanup() {
      execSync(`${CONTAINER_BIN} rm -f ${name} >/dev/null 2>&1 || true`);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 清空 test 用户的 INBOX maildir；dovecot 再次访问时自动重建并生成新的 UIDVALIDITY */
export function resetMaildir(handle: DovecotHandle): void {
  execFileSync(CONTAINER_BIN, ["exec", handle.container, "sh", "-c", "rm -rf /srv/mail/test"]);
}

/** 通过 IMAP APPEND 投放 fixtures 邮件（不带 \\Seen，即未读）；folder 缺省 INBOX */
export async function deliverFixtures(
  handle: DovecotHandle,
  names: string[],
  folder = "INBOX"
): Promise<void> {
  const client = new ImapFlow({
    host: handle.host,
    port: handle.port,
    secure: false,
    auth: { user: "test", pass: "test" },
    logger: false,
  });
  await client.connect();
  try {
    for (const n of names) {
      const ok = await client.append(folder, readFileSync(join(fixturesDir, n)));
      if (!ok) throw new Error(`APPEND 失败：${n}`);
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function waitReady(handle: DovecotHandle): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const client = new ImapFlow({
        host: handle.host,
        port: handle.port,
        secure: false,
        auth: { user: "test", pass: "test" },
        logger: false,
      });
      await client.connect();
      await client.logout();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr;
}
