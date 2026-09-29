export interface AccountConfig {
  id: string;
  displayName: string;
  email: string;
  provider: string;
  color: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  /** 待同步文件夹白名单 */
  folders: string[];
  enabled: boolean;
  /** SMTP 字段：仅 agent@ 账号持有（3.1：外部源与 me@ 只有 IMAP 读取凭据） */
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  /** true = 这是 agent@ 自己的账号（工具面发信身份；发信闸门白名单 = 其余账号的地址） */
  isAgent?: boolean;
}

export interface AccountCredential {
  username: string;
  password: string;
}

/** CalDAV 写入目标（create_event）：accounts.json 顶层的 caldav 段 */
export interface CaldavConfig {
  /** Radicale 根 URL，如 https://calendar.shaoyuanyu.cn */
  url: string;
  /** 集合名，缺省 agent-schedule */
  collection?: string;
}

/** 模型配置（accounts.json 顶层的 model 段；apiKey 在 credentials.json 的 model 键） */
export interface ModelConfig {
  /** OpenAI 兼容端点，如 https://api.deepseek.com/v1 */
  baseURL: string;
  /** 模型名，如 deepseek-chat */
  model: string;
  /** 每日汇报的小时（本地时间，缺省 21） */
  reportHour?: number;
}

export interface AccountsFile {
  accounts: AccountConfig[];
  caldav?: CaldavConfig;
  model?: ModelConfig;
}

export type CredentialsFile = Record<string, AccountCredential>;

export interface SyncResult {
  accountId: string;
  folder: string;
  /** UIDVALIDITY 变化导致该文件夹索引重建 */
  rebuilt: boolean;
  fetched: number;
  flagsUpdated: number;
  /** 本次新入库的邮件（库键 + 是否首次出现）；触发接线用它投 judge/command 任务 */
  ingested: { messageId: string; created: boolean }[];
}
