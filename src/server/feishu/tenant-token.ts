import { SingleFlight } from "../core/single-flight";
import { retryOperation } from "../core/retry";

interface TenantTokenConfig {
  appId: string;
  appSecret: string;
}

interface TenantTokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

export class TenantTokenProvider {
  private readonly flight = new SingleFlight<string>();
  private cached?: { token: string; expiresAt: number };

  constructor(
    private readonly config: TenantTokenConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > this.now() + 5 * 60 * 1000) return this.cached.token;
    return this.flight.run("tenant", async () => {
      if (this.cached && this.cached.expiresAt > this.now() + 5 * 60 * 1000) return this.cached.token;
      const result = await retryOperation(async () => {
        let response: Response;
        try {
          response = await this.fetcher("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
          });
        } catch {
          throw Object.assign(new Error("连接飞书认证服务失败"), { retryable: true });
        }
        let payload: TenantTokenResponse = {};
        try {
          payload = (await response.json()) as TenantTokenResponse;
        } catch {
          if (response.ok) {
            throw Object.assign(new Error("飞书应用令牌响应格式无效"), { retryable: false });
          }
        }
        if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
          throw Object.assign(new Error(payload.msg || `获取飞书应用令牌失败（HTTP ${response.status}）`), {
            code: String(payload.code ?? response.status),
            retryable: response.status === 429 || response.status >= 500,
          });
        }
        if (!payload.tenant_access_token || !payload.expire) {
          throw Object.assign(new Error("飞书应用令牌响应不完整"), { retryable: false });
        }
        return { token: payload.tenant_access_token, expiresIn: payload.expire };
      });
      this.cached = { token: result.token, expiresAt: this.now() + result.expiresIn * 1000 };
      return result.token;
    });
  }
}
