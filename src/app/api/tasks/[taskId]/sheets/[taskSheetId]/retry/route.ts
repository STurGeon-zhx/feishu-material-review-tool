import { fail, ok } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";
import { toTaskSheetDto } from "@/server/tasks/task-dto";

export async function POST(
  _request: Request,
  context: { params: Promise<{ taskId: string; taskSheetId: string }> },
) {
  try {
    const { taskId, taskSheetId } = await context.params;
    return ok(toTaskSheetDto(await getAppContext().tasks.retrySheet(taskId, taskSheetId)));
  } catch (error) {
    return fail(error, "RETRY_TASK_SHEET_FAILED", 502);
  }
}
