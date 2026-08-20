import type { AppDatabase } from "../db/client";
import { getConnection, upsertConnection } from "../db/repository";
import { decryptSecret, encryptSecret } from "../security/token-crypto";
import { SingleFlight } from "../core/single-flight";
import { retryOperation } from "../core/retry";

interface AuthConfig {
  appId: string;
  appSecret: string;
  encryptionKey: string;
}

interface UserTokenData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_expires_in?: number;
  scope?: string;
  token_type?: string;
}

async function readEnvelope<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as { code?: number; msg?: string; data?: T } & T;
  if (!response.ok || (payload.code !== undefined && payload.code !== 0)) {
    throw new Error(payload.msg || `飞书认证失败（HTTP ${response.status}）`);
  }
  return (payload.data ?? payload) as T;
}

export class FeishuAuth {
  private readonly refreshFlight = new SingleFlight<string>();

  constructor(
    private readonly db: AppDatabase,
    private readonly config: AuthConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async fetchWithRetry(input: string, init?: RequestInit): Promise<Response> {
    return retryOperation(async () => {
      try {
        const response = await this.fetcher(input, init);
        if (response.status === 429 || response.status >= 500) {
          throw Object.assign(new Error(`飞书认证服务暂时不可用（HTTP ${response.status}）`), {
            retryable: true,
          });
        }
        return response;
      } catch (error) {
        if (typeof error === "object" && error && "retryable" in error) throw error;
        throw Object.assign(new Error("连接飞书认证服务失败"), { retryable: true });
      }
    });
  }

  private async getAppAccessToken(): Promise<string> {
    const response = await this.fetchWithRetry("https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
    });
    const data = await readEnvelope<{ app_access_token: string }>(response);
    return data.app_access_token;
  }

  private async requestUserToken(path: "access_token" | "refresh_access_token", body: object): Promise<UserTokenData> {
    const appAccessToken = await this.getAppAccessToken();
    const response = await this.fetchWithRetry(`https://open.feishu.cn/open-apis/authen/v1/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appAccessToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    return readEnvelope<UserTokenData>(response);
  }

  async exchangeAndStore(code: string, localUserId: string): Promise<{ openId: string; name?: string }> {
    const token = await this.requestUserToken("access_token", { grant_type: "authorization_code", code });
    const userResponse = await this.fetchWithRetry("https://open.feishu.cn/open-apis/authen/v1/user_info", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const user = await readEnvelope<{ open_id: string; name?: string }>(userResponse);
    this.store(localUserId, user.open_id, user.name, token);
    return { openId: user.open_id, name: user.name };
  }

  async getValidAccessToken(localUserId: string): Promise<string> {
    const connection = getConnection(this.db, localUserId);
    if (!connection) throw Object.assign(new Error("请先连接飞书账号"), { code: "FEISHU_NOT_CONNECTED" });
    if (connection.accessExpiresAt > this.now() + 5 * 60 * 1000) {
      return decryptSecret(connection.accessTokenCiphertext, this.config.encryptionKey);
    }
    return this.refreshFlight.run(localUserId, async () => {
      const latest = getConnection(this.db, localUserId);
      if (!latest) throw new Error("飞书连接不存在");
      if (latest.accessExpiresAt > this.now() + 5 * 60 * 1000) {
        return decryptSecret(latest.accessTokenCiphertext, this.config.encryptionKey);
      }
      const refreshToken = decryptSecret(latest.refreshTokenCiphertext, this.config.encryptionKey);
      const token = await this.requestUserToken("refresh_access_token", {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
      this.store(localUserId, latest.feishuOpenId, latest.feishuName ?? undefined, token);
      return token.access_token;
    });
  }

  private store(localUserId: string, openId: string, name: string | undefined, token: UserTokenData): void {
    const now = this.now();
    upsertConnection(this.db, {
      localUserId,
      feishuOpenId: openId,
      feishuName: name,
      accessTokenCiphertext: encryptSecret(token.access_token, this.config.encryptionKey),
      refreshTokenCiphertext: encryptSecret(token.refresh_token, this.config.encryptionKey),
      accessExpiresAt: now + token.expires_in * 1000,
      refreshExpiresAt: token.refresh_expires_in ? now + token.refresh_expires_in * 1000 : null,
      scopes: token.scope ?? "",
    });
  }
}
