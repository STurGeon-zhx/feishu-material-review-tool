import { fail, ok } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";

export async function POST(
  _request: Request,
  context: { params: Promise<{ taskId: string; batchId: string }> },
) {
  try {
    const { taskId, batchId } = await context.params;
    const app = getAppContext();
    app.tasks.getTaskForActiveAccount(taskId);
    return ok(await app.sheetFinalizer.run(taskId, batchId));
  } catch (error) {
    return fail(error, "FINALIZE_BATCH_FAILED", 502);
  }
}
