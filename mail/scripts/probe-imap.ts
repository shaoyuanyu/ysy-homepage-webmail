import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { loadAccounts, loadCredentials } from "../src/config.js";

/**
 * 账号实测探针（MAIL-AGENT.md 第八节 第 0 步前置）：
 * - IMAP 登录是否成功（账号级验证）
 * - 服务能力：IDLE（5.1 唤醒方式）、THREAD（6.1 会话组装）、SPECIAL-USE（\Sent 探测，红线 5）
 * - 文件夹清单与 special-use 标志位
 * - 有 smtpHost 的账号做 SMTP auth 验证（verify 只握手不发信）
 * 凭据从 MAIL_DATA_DIR（缺省 ./data/mail）读取，不打印任何凭据。
 */

const dataDir = process.env.MAIL_DATA_DIR ?? "data/mail";
const accounts = loadAccounts(dataDir).filter((a) => a.enabled);
const creds = loadCredentials(dataDir);

let failed = false;

for (const account of accounts) {
  const cred = creds[account.id];
  if (!cred) {
    console.error(`[${account.id}] credentials.json 缺该账号条目`);
    failed = true;
    continue;
  }
  console.log(`\n=== ${account.id} <${account.email}> (${account.imapHost}) ===`);

  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    // PROBE_USER 可临时覆盖登录名（排查「全地址 vs 裸用户名」类问题）
    auth: { user: process.env.PROBE_USER ?? cred.username, pass: cred.password },
    logger: false,
    socketTimeout: 20_000,
  });
  try {
    await client.connect();
    console.log("IMAP 登录：OK");
    const caps = [...client.capabilities.keys()].sort();
    const has = (prefix: string) => caps.some((c) => c === prefix || c.startsWith(`${prefix}=`));
    console.log(`能力：IDLE=${has("IDLE")} THREAD=${caps.find((c) => c.startsWith("THREAD")) ?? "无"} SPECIAL-USE=${has("SPECIAL-USE")} UIDPLUS=${has("UIDPLUS")} MOVE=${has("MOVE")}`);

    const boxes = await client.list();
    for (const b of boxes) {
      // 服务端不支持 SPECIAL-USE 时 imapflow 不返回该字段（类型定义未收录，运行时存在）
      const attrs = (b as { specialUseAttribs?: string[] }).specialUseAttribs ?? [];
      console.log(`  文件夹 ${b.path}${attrs.length ? `  [${attrs.join(" ")}]` : ""}`);
    }

    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const mb = client.mailbox;
      console.log(`INBOX：exists=${mb ? mb.exists : "?"}`);
    } finally {
      lock.release();
    }
  } catch (err) {
    const e = err as { message?: string; responseText?: string; response?: string; serverResponseCode?: string };
    console.error(`IMAP 失败：${e.message}${e.responseText ? ` | 服务端: ${e.responseText}` : ""}${e.response ? ` | ${e.response}` : ""}`);
    failed = true;
  } finally {
    await client.logout().catch(() => {});
  }

  if (account.smtpHost) {
    const transporter = nodemailer.createTransport({
      host: account.smtpHost,
      port: account.smtpPort ?? 465,
      secure: account.smtpSecure ?? true,
      auth: { user: cred.username, pass: cred.password },
      connectionTimeout: 20_000,
    });
    try {
      await transporter.verify();
      console.log("SMTP 登录：OK（verify，未发信）");
    } catch (err) {
      console.error(`SMTP 失败：${err instanceof Error ? err.message : String(err)}`);
      failed = true;
    }
  }
}

process.exit(failed ? 1 : 0);
