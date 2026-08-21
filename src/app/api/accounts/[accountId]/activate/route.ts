import { fail, ok } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";

export async function POST(_request: Request, context: { params: Promise<{ accountId: string }> }) {
  try {
    const { accountId } = await context.params;
    const app = getAppContext();
    app.accounts.activate(accountId);
    return ok(app.accounts.list().find((account) => account.id === accountId)!);
  } catch (error) {
    return fail(error, "ACTIVATE_ACCOUNT_FAILED", 404);
  }
}
