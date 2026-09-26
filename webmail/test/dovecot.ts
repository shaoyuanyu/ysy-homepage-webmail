import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ImapFlow } from "imapflow";

/** 本机用 podman（rootless）；CI 或 VPS 上用 docker。maildir 不挂卷、由容器自管 */
const CONTAINER_BIN = process.env.CONTAINER_BIN ?? "docker";
const IMAGE = process.env.DOVECOT_IMAGE ?? "docker.io/dovecot/dovecot:2.3.21";

const here = dirname(fileURLToPath(import.meta.url));
export const workRoot = join(here, "..", ".test-data");
export const fixturesDir = join(here, "fixtures", "eml");

/** Sent / Trash 带 special_use 标志位（RFC 6154），供探测逻辑走主路径 */
const DOVECOT_CONF = `protocols = imap
listen = *
ssl = no
disable_plaintext_auth = no
auth_mechanisms = plain login
mail_location = maildir:/srv/mail/%u
mail_privileged_group = mail
namespace inbox {
  inbox = yes
  mailbox Sent {
    special_use = \\Sent
    auto = create
  }
  mailbox Trash {
    special_use = \\Trash
    auto = create
  }
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

/** 双账号：跨账号多副本用例需要两个独立 UID 空间 */
const USERS = "test:{PLAIN}test::::::\ntest2:{PLAIN}test2::::::\n";

export interface DovecotHandle {
  container: string;
  host: string;
  port: number;
  dir: string;
  cleanup(): void;
}

export function startDovecot(suffix: string, conf: string = DOVECOT_CONF): DovecotHandle {
  const name = `webmaild-test-${suffix}-${process.pid}`;
  execSync(`${CONTAINER_BIN} rm -f ${name} >/dev/null 2>&1 || true`);

  const dir = join(workRoot, `dovecot-${suffix}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "dovecot.conf"), conf);
  writeFileSync(join(dir, "users"), USERS);

  const args = [
    "run", "-d", "--name", name,
    "-v", `${dir}/dovecot.conf:/etc/dovecot/dovecot.conf:Z`,
    "-v", `${dir}/users:/etc/dovecot/users:Z`,
    "-p", "127.0.0.1::143",
    IMAGE,
  ];
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
    cleanup() {
      execSync(`${CONTAINER_BIN} rm -f ${name} >/dev/null 2>&1 || true`);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function connectUser(
  handle: DovecotHandle,
  user: string,
  pass: string
): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: handle.host,
    port: handle.port,
    secure: false,
    auth: { user, pass },
    logger: false,
  });
  await client.connect();
  return client;
}

/** 通过 IMAP APPEND 投放 fixtures 邮件到指定账号（不带 \Seen，即未读） */
export async function deliverFixtures(
  handle: DovecotHandle,
  user: string,
  pass: string,
  names: string[],
  folder = "INBOX"
): Promise<void> {
  const client = await connectUser(handle, user, pass);
  try {
    for (const n of names) {
      const ok = await client.append(folder, readFileSync(join(fixturesDir, n)));
      if (!ok) throw new Error(`APPEND 失败：${n}`);
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/** 读回某文件夹全部邮件的 flags（uid → flags），供断言用 */
export async function readAllFlags(
  handle: DovecotHandle,
  user: string,
  pass: string,
  folder: string
): Promise<Map<number, string[]>> {
  const client = await connectUser(handle, user, pass);
  try {
    await client.mailboxOpen(folder, { readOnly: true });
    const out = new Map<number, string[]>();
    const uids = (await client.search({}, { uid: true })) || [];
    for await (const msg of client.fetch(uids, { uid: true, flags: true }, { uid: true })) {
      out.set(msg.uid, msg.flags ? [...msg.flags] : []);
    }
    return out;
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function waitReady(handle: DovecotHandle): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const client = await connectUser(handle, "test", "test");
      await client.logout();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr;
}
