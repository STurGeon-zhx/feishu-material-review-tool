import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fail, ok } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";
import { canRegisterTaskBatch, registerBatch } from "@/server/db/repository";
import { toTaskAssetDto } from "@/server/tasks/task-dto";

const schema = z.object({
  taskSheetId: z.string().min(1),
  importMode: z.enum(["preview", "attachment"]).default("preview"),
  files: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.string(),
    size: z.number().int().positive(),
  })).min(1),
});

export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = await context.params;
    const input = schema.parse(await request.json());
    const app = getAppContext();
    app.tasks.getTaskForActiveAccount(taskId);
    const db = app.database.db;
    if (!canRegisterTaskBatch(db, taskId, input.taskSheetId)) {
      return fail(new Error("任务或目标工作表不可登记新批次"), "TASK_NOT_ACCEPTING_BATCHES", 409);
    }
    const batchId = randomUUID();
    const rows = registerBatch(db, taskId, batchId, input.files, input.taskSheetId, input.importMode);
    return ok({ batchId, batchNumber: rows[0].batchNumber, assets: rows.map(toTaskAssetDto) }, 201);
  } catch (error) {
    return fail(error, "CREATE_BATCH_FAILED", 400);
  }
}
