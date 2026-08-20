import { ok, fail } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    return ok(await getAppContext().projectSetup.run(id));
  } catch (error) {
    return fail(error, "PROJECT_SETUP_RETRY_FAILED", 502);
  }
}
