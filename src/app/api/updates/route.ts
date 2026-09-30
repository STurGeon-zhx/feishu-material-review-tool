import packageInfo from "../../../../package.json";
import { fail, ok } from "@/server/api-response";
import { checkUpdate } from "@/server/updates/check-update";

export async function GET() {
  try {
    return ok(await checkUpdate(packageInfo.version));
  } catch (error) {
    return fail(error, "UPDATE_CHECK_FAILED", 502);
  }
}
