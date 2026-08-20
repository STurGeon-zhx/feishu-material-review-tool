import { NextResponse } from "next/server";
import { FeishuApiError } from "./feishu/http-client";

export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ ok: true, data }, { status });
}

export function fail(error: unknown, fallbackCode = "INTERNAL_ERROR", status = 500) {
  const code =
    error instanceof FeishuApiError
      ? error.code
      : typeof error === "object" && error && "code" in error
        ? String(error.code)
        : fallbackCode;
  const message = error instanceof Error ? error.message : "服务器处理失败";
  const retryable = error instanceof FeishuApiError ? error.retryable : Boolean(
    typeof error === "object" && error && "retryable" in error && error.retryable,
  );
  const feishuRequestId = error instanceof FeishuApiError ? error.feishuRequestId : undefined;
  console.error(JSON.stringify({ event: "api_error", code, retryable, feishuRequestId }));
  return NextResponse.json(
    { ok: false, error: { code, message, retryable, ...(feishuRequestId ? { feishuRequestId } : {}) } },
    { status },
  );
}
