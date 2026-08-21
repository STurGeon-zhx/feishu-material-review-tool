import { fail, ok } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";
import { toTaskDto } from "@/server/tasks/task-dto";

export async function POST(_request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = await context.params;
    return ok(toTaskDto(await getAppContext().tasks.retry(taskId)));
  } catch (error) {
    return fail(error, "RETRY_TASK_FAILED", 502);
  }
}
