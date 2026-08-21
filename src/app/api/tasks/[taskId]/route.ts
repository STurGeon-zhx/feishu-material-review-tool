import { fail, ok } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";
import { getProjectAssets, getProjectChecks } from "@/server/db/repository";
import { calculateOverallStatus } from "@/server/verification/summary";
import { toTaskAssetDto, toTaskDto, toTaskSheetDto } from "@/server/tasks/task-dto";

export async function GET(_request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = await context.params;
    const app = getAppContext();
    const task = app.tasks.getTask(taskId);
    const account = app.accounts.getActive();
    if (!task || !account || task.accountId !== account.id) {
      return fail(new Error("当前账号下不存在该任务"), "TASK_NOT_FOUND", 404);
    }
    await app.sheetFinalizer.resumeProject(taskId);
    const checks = getProjectChecks(app.database.db, taskId);
    return ok({
      task: toTaskDto(app.tasks.getTask(taskId)!),
      sheets: app.tasks.getSheets(taskId).map(toTaskSheetDto),
      assets: getProjectAssets(app.database.db, taskId).map(toTaskAssetDto),
      checks,
      overallStatus: calculateOverallStatus(checks),
    });
  } catch (error) {
    return fail(error, "GET_TASK_FAILED");
  }
}
