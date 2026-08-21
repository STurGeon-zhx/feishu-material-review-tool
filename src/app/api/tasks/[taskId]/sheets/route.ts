import { z } from "zod";
import { fail, ok } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";
import { toTaskSheetDto } from "@/server/tasks/task-dto";

const createSchema = z.object({ name: z.string().trim().min(1).max(100) });

export async function GET(_request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    const { taskId } = await context.params;
    const app = getAppContext();
    app.tasks.getTaskForActiveAccount(taskId);
    return ok(app.tasks.getSheets(taskId).map(toTaskSheetDto));
  } catch (error) {
    return fail(error, "GET_TASK_SHEETS_FAILED", 404);
  }
}

export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const createKey = request.headers.get("Idempotency-Key");
  if (!createKey) return fail(new Error("缺少 Idempotency-Key"), "IDEMPOTENCY_KEY_REQUIRED", 400);
  try {
    const { taskId } = await context.params;
    const { name } = createSchema.parse(await request.json());
    return ok(toTaskSheetDto(await getAppContext().tasks.createSheet(taskId, createKey, name)), 201);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    return fail(error, "CREATE_TASK_SHEET_FAILED", code === "TASK_SHEET_NAME_EXISTS" ? 409 : error instanceof z.ZodError ? 400 : 502);
  }
}
