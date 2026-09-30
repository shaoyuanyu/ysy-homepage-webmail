import { loadAccounts, loadCredentials, webmailDataDir } from "../src/config.js";
import { sendMessage } from "../src/send.js";

/**
 * 命令行发信（运维/联调用）：走 webmaild 同一条 sendMessage 路径
 * （红线 5：探测不到「已发送」拒发；红线 6：SMTP 与 APPEND 同一份字节）。
 * 用法：pnpm exec tsx scripts/send.ts [--account me] --to a@b --subject "主题" --text "正文"
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dataDir = process.env.WEBMAIL_DATA_DIR ?? webmailDataDir();
const { accounts } = loadAccounts(dataDir);
const creds = loadCredentials(dataDir);

const accountId = arg("account") ?? accounts[0]?.id;
const to = arg("to");
const subject = arg("subject");
const text = arg("text") ?? "";
if (!accountId || !to || !subject) {
  console.error("用法：send.ts [--account id] --to <addr> --subject <s> [--text <t>]");
  process.exit(2);
}

const account = accounts.find((a) => a.id === accountId);
if (!account) throw new Error(`账号不存在：${accountId}`);

const result = await sendMessage(account, creds[account.id], {
  accountId: account.id,
  to: [to],
  subject,
  text,
});
console.log(`已发出并留底：${result.messageId} → ${result.sentFolder}`);
