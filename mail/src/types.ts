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
}

export interface AccountCredential {
  username: string;
  password: string;
}

export interface AccountsFile {
  accounts: AccountConfig[];
}

export type CredentialsFile = Record<string, AccountCredential>;

export interface SyncResult {
  accountId: string;
  folder: string;
  /** UIDVALIDITY 变化导致该文件夹索引重建 */
  rebuilt: boolean;
  fetched: number;
  flagsUpdated: number;
}
