import { NextRequest, NextResponse } from "next/server";
import { getAppContext } from "@/server/app-context";
import { fail } from "@/server/api-response";

export async function GET(request: NextRequest) {
  try {
    const error = request.nextUrl.searchParams.get("error");
    if (error) throw Object.assign(new Error(`飞书授权未完成：${error}`), { code: "OAUTH_DENIED" });
    const code = request.nextUrl.searchParams.get("code");
    const state = request.nextUrl.searchParams.get("state");
    const expectedState = request.cookies.get("feishu_oauth_state")?.value;
    if (!code || !state || !expectedState || state !== expectedState) {
      throw Object.assign(new Error("飞书授权状态校验失败，请重新连接"), { code: "OAUTH_STATE_INVALID" });
    }
    const { auth, config } = getAppContext();
    await auth.exchangeAndStore(code, config.demoUserId);
    const response = NextResponse.redirect(new URL("/?feishu=connected", request.url));
    response.cookies.delete("feishu_oauth_state");
    return response;
  } catch (error) {
    return fail(error, "OAUTH_CALLBACK_FAILED", 400);
  }
}
