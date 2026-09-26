import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";

export interface SmtpSink {
  port: number;
  /** 收到的每封邮件的原始字节（DATA 阶段内容） */
  received: Buffer[];
  close(): Promise<void>;
}

/** 内存 SMTP 接收端：断言「SMTP 发出与 APPEND 留底是同一份字节」（红线 6） */
export async function startSmtpSink(): Promise<SmtpSink> {
  const received: Buffer[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disableReverseLookup: true,
    // 不宣告 STARTTLS：内置证书已过期且仅用于本地测试， nodemailer 默认的机会性 STARTTLS 会因证书过期失败
    hideSTARTTLS: true,
    // 没有 onAuth 时服务端对 AUTH 直接回 535；本地测试任意通过
    onAuth(_auth, _session, callback) {
      callback(null, { user: "any" });
    },
    onData(stream, _session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        received.push(Buffer.concat(chunks));
        callback();
      });
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.server.address() as AddressInfo;
  return {
    port: addr.port,
    received,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
