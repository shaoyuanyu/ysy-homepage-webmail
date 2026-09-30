import dns from "node:dns";
import { readFileSync } from "node:fs";
import { authenticate } from "mailauth";

/** SPF temperror 排错：手动解析 SPF 链 + 打印 mailauth 完整 SPF 状态 */

const resolver = new dns.promises.Resolver();
resolver.setServers(["223.5.5.5", "119.29.29.29"]);

for (const name of ["mail.shaoyuanyu.cn", "spf.qiye.aliyun.com", "shaoyuanyu.cn"]) {
  try {
    const txt = await resolver.resolveTxt(name);
    console.log(`TXT ${name} =>`, JSON.stringify(txt.flat()));
  } catch (err) {
    console.log(`TXT ${name} !! ${err instanceof Error ? err.message : String(err)}`);
  }
}

const eml = readFileSync(process.argv[2] ?? "data/mail/eml/8964e2173d5d31a505a73cd6bbe9ab4125f0f27c.eml");
const resolve = (name: string, type: string) => resolver.resolve(name, type as never) as Promise<string[][]>;
const r = await authenticate(eml, { trustReceived: true, resolver: resolve });
console.log("spf 完整状态：", JSON.stringify(r.spf, null, 1));
console.log("sender/ip：", JSON.stringify(r.status, null, 1));
