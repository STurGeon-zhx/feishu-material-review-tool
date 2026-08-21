import { z } from "zod";
import { fail, ok } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";
import { toTaskDto } from "@/server/tasks/task-dto";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  firstSheetName: z.string().trim().min(1).max(100),
});

export async function GET() {
  try {
    const app = getAppContext();
    const active = app.accounts.getActive();
    return ok({
      tasks: app.tasks.listForActiveAccount().map(toTaskDto),
      activeTaskId: active?.activeTaskId ?? null,
    });
  } catch (error) {
    return fail(error, "GET_TASKS_FAILED");
  }
}

export async function POST(request: Request) {
  const createKey = request.headers.get("Idempotency-Key");
  if (!createKey) return fail(new Error("缺少 Idempotency-Key"), "IDEMPOTENCY_KEY_REQUIRED", 400);
  try {
    const input = createSchema.parse(await request.json());
    return ok(toTaskDto(await getAppContext().tasks.create(createKey, input)), 201);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    return fail(error, "CREATE_TASK_FAILED", code === "TASK_NAME_EXISTS" ? 409 : error instanceof z.ZodError ? 400 : 502);
  }
}
