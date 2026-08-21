const FEISHU_ORIGIN = "https://open.feishu.cn";

export class FeishuApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly feishuRequestId?: string;
  readonly status: number;

  constructor(input: { code: string; message: string; retryable: boolean; status: number; feishuRequestId?: string }) {
    super(input.message);
    this.name = "FeishuApiError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.status = input.status;
    this.feishuRequestId = input.feishuRequestId;
  }
}

type FeishuEnvelope<T> = { code?: number; msg?: string; data?: T } & T;

function isRetryable(status: number, code: number | undefined): boolean {
  return status === 429 || status >= 500 || code === 1254291 || code === 1061045 || code === 1061006;
}

export class FeishuHttpClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.accessToken}`);
    if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json; charset=utf-8");
    }

    let response: Response;
    try {
      response = await this.fetcher(path.startsWith("http") ? path : `${FEISHU_ORIGIN}${path}`, {
        ...init,
        headers,
      });
    } catch {
      throw new FeishuApiError({
        code: "NETWORK_ERROR",
        message: "连接飞书 OpenAPI 失败",
        retryable: true,
        status: 0,
      });
    }
    const requestId = response.headers.get("x-tt-logid") ?? response.headers.get("x-lark-request-id") ?? undefined;
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("json")
      ? ((await response.json()) as FeishuEnvelope<T>)
      : ({ msg: await response.text() } as FeishuEnvelope<T>);
    const code = typeof payload.code === "number" ? payload.code : undefined;

    if (!response.ok || (code !== undefined && code !== 0)) {
      throw new FeishuApiError({
        code: String(code ?? response.status),
        message: payload.msg || `飞书请求失败（HTTP ${response.status}）`,
        retryable: isRetryable(response.status, code),
        status: response.status,
        feishuRequestId: requestId,
      });
    }
    return (payload.data ?? payload) as T;
  }
}
