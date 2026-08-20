import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getAppContext } from "@/server/app-context";
import { fail } from "@/server/api-response";
import { buildAuthorizeUrl } from "@/server/feishu/http-client";

export async function GET() {
  try {
    const { config } = getAppContext();
    const state = randomBytes(24).toString("base64url");
    const response = NextResponse.redirect(
      buildAuthorizeUrl({ appId: config.appId, redirectUri: config.redirectUri, state }),
    );
    response.cookies.set("feishu_oauth_state", state, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 600,
      path: "/",
    });
    return response;
  } catch (error) {
    return fail(error, "FEISHU_CONNECT_FAILED");
  }
}
