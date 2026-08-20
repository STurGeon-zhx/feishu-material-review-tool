import { ok, fail } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";
import { getConnection } from "@/server/db/repository";

export async function GET() {
  try {
    const { database, config, auth } = getAppContext();
    const connection = getConnection(database.db, config.demoUserId);
    if (!connection) return ok({ connected: false });
    try {
      await auth.getValidAccessToken(config.demoUserId);
    } catch {
      return ok({
        connected: false,
        reconnectRequired: true,
        name: connection.feishuName,
        openId: connection.feishuOpenId,
        message: "飞书授权已失效，请重新连接",
      });
    }
    return ok({
      connected: true,
      name: connection.feishuName,
      openId: connection.feishuOpenId,
      expiresAt: connection.accessExpiresAt,
    });
  } catch (error) {
    return fail(error, "CONNECTION_STATUS_FAILED");
  }
}
