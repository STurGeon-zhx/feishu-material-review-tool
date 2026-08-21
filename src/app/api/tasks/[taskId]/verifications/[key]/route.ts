import { z } from "zod";
import { fail, ok } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";
import { getProject, upsertVerification } from "@/server/db/repository";

const schema = z.object({ status: z.enum(["pass", "fail"]), note: z.string().max(1000).optional() });
const manualKeys = new Set(["anonymous_view", "anonymous_edit"]);

export async function PATCH(
  request: Request,
  context: { params: Promise<{ taskId: string; key: string }> },
) {
  try {
    const { taskId, key } = await context.params;
    if (!manualKeys.has(key)) return fail(new Error("该验证项不可人工修改"), "CHECK_NOT_MANUAL", 400);
    const input = schema.parse(await request.json());
    const app = getAppContext();
    const task = getProject(app.database.db, taskId);
    const account = app.accounts.getActive();
    if (!task || !account || task.accountId !== account.id) {
      return fail(new Error("当前账号下不存在该任务"), "TASK_NOT_FOUND", 404);
    }
    upsertVerification(app.database.db, {
      projectId: taskId,
      checkKey: key,
      source: "manual",
      status: input.status,
      note: input.note ?? "",
      checkedAt: new Date().toISOString(),
    });
    return ok({ checkKey: key, ...input });
  } catch (error) {
    return fail(error, "UPDATE_VERIFICATION_FAILED", 400);
  }
}
