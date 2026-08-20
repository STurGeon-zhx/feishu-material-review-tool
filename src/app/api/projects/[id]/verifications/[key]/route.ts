import { z } from "zod";
import { ok, fail } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";
import { upsertVerification } from "@/server/db/repository";

const schema = z.object({ status: z.enum(["pass", "fail"]), note: z.string().max(1000).optional() });

export async function PATCH(request: Request, context: { params: Promise<{ id: string; key: string }> }) {
  try {
    const { id, key } = await context.params;
    if (!new Set(["anonymous_view", "anonymous_edit"]).has(key)) {
      return fail(new Error("只允许人工更新匿名查看和匿名编辑"), "INVALID_MANUAL_CHECK", 400);
    }
    const input = schema.parse(await request.json());
    const { database } = getAppContext();
    upsertVerification(database.db, {
      projectId: id,
      checkKey: key,
      source: "manual",
      status: input.status,
      note: input.note,
      checkedAt: new Date().toISOString(),
    });
    return ok({ checkKey: key, ...input });
  } catch (error) {
    return fail(error, "UPDATE_VERIFICATION_FAILED", 400);
  }
}
