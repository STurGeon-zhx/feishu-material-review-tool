import { z } from "zod";
import { fail, ok } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  appSecret: z.string().min(1).max(500).optional(),
}).refine((value) => value.name !== undefined || value.appSecret !== undefined, "至少提供一个修改项");

export async function PATCH(request: Request, context: { params: Promise<{ accountId: string }> }) {
  try {
    const { accountId } = await context.params;
    const input = updateSchema.parse(await request.json());
    const app = getAppContext();
    await app.accounts.update(accountId, input);
    app.accountRuntimes.invalidate(accountId);
    return ok(app.accounts.list().find((account) => account.id === accountId)!);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    return fail(error, "UPDATE_ACCOUNT_FAILED", code === "ACCOUNT_NOT_FOUND" ? 404 : 400);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ accountId: string }> }) {
  try {
    const { accountId } = await context.params;
    const app = getAppContext();
    const result = app.accounts.delete(accountId);
    app.accountRuntimes.invalidate(accountId);
    return ok(result);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    return fail(error, "DELETE_ACCOUNT_FAILED", code === "ACCOUNT_NOT_FOUND" ? 404 : 400);
  }
}
