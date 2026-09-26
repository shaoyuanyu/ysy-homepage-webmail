import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../mail/src/db.js";
import type { WebmailContext } from "../src/api.js";
import type { WebmailAccount } from "../src/types.js";
import { workRoot, type DovecotHandle } from "./dovecot.js";

export interface TestContext {
  ctx: WebmailContext;
  dir: string;
  cleanup(): void;
}

/** 双账号测试上下文：acc1 → test，acc2 → test2（同一容器、两个独立 UID 空间） */
export function makeContext(
  handle: DovecotHandle,
  smtpPort: number,
  suffix: string
): TestContext {
  const dir = join(workRoot, `data-${suffix}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const base = {
    provider: "dovecot-test",
    color: "sky",
    imapHost: handle.host,
    imapPort: handle.port,
    imapSecure: false,
    smtpHost: "127.0.0.1",
    smtpPort,
    smtpSecure: false,
    folders: ["INBOX", "Sent", "Trash"],
    enabled: true,
  };
  const accounts: WebmailAccount[] = [
    { ...base, id: "acc1", displayName: "测试一", email: "test@local" },
    { ...base, id: "acc2", displayName: "测试二", email: "test2@local" },
  ];
  writeFileSync(
    join(dir, "accounts.json"),
    JSON.stringify({ accounts, remoteImageDomains: ["edu.cn"] }, null, 2)
  );
  writeFileSync(
    join(dir, "credentials.json"),
    JSON.stringify({
      acc1: { username: "test", password: "test" },
      acc2: { username: "test2", password: "test2" },
    })
  );

  const ctx: WebmailContext = {
    db: openDb(join(dir, "webmail.db")),
    dataDir: dir,
    accounts: new Map(accounts.map((a) => [a.id, a])),
    credentials: new Map([
      ["acc1", { username: "test", password: "test" }],
      ["acc2", { username: "test2", password: "test2" }],
    ]),
    remoteImageDomains: ["edu.cn"],
    syncStates: new Map(),
  };

  return {
    ctx,
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
