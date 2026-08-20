import { ok, fail } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";

export async function POST(_request: Request, context: { params: Promise<{ id: string; batchId: string }> }) {
  try {
    const { id, batchId } = await context.params;
    return ok(await getAppContext().finalizer.run(id, batchId));
  } catch (error) {
    return fail(error, "FINALIZE_BATCH_FAILED", 502);
  }
}
