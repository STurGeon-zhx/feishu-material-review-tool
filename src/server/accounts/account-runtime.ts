import type { AccountCredentials } from "./account-service";
import { FeishuHttpClient } from "../feishu/http-client";
import { FeishuSheetsService } from "../feishu/sheets-service";
import { TenantTokenProvider } from "../feishu/tenant-token";

interface CachedRuntime {
  version: string;
  provider: TenantTokenProvider;
}

export class AccountRuntimeRegistry {
  private readonly runtimes = new Map<string, CachedRuntime>();

  constructor(private readonly getCredentials: (accountId: string) => AccountCredentials) {}

  invalidate(accountId: string): void {
    this.runtimes.delete(accountId);
  }

  getProvider(accountId: string): TenantTokenProvider {
    const credentials = this.getCredentials(accountId);
    const cached = this.runtimes.get(accountId);
    if (cached?.version === credentials.version) return cached.provider;
    const provider = new TenantTokenProvider(credentials);
    this.runtimes.set(accountId, { version: credentials.version, provider });
    return provider;
  }

  async createSheetsService(accountId: string): Promise<FeishuSheetsService> {
    const token = await this.getProvider(accountId).getToken();
    return new FeishuSheetsService(new FeishuHttpClient(token));
  }
}
