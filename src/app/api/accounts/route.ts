import { z } from "zod";
import { fail, ok } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";

const createSchema = z.object({
  name: z.string().trim().min(1).max(50),
  appId: z.string().trim().min(5).max(200).regex(/^cli_/, "App ID 应以 cli_ 开头"),
  appSecret: z.string().min(1).max(500),
});

export async function GET() {
  try {
    const app = getAppContext();
    const accounts = app.accounts.list();
    return ok({ accounts, activeAccountId: accounts.find((account) => account.isActive)?.id ?? null });
  } catch (error) {
    return fail(error, "GET_ACCOUNTS_FAILED");
  }
}

export async function POST(request: Request) {
  try {
    const input = createSchema.parse(await request.json());
    const app = getAppContext();
    const created = await app.accounts.create(input);
    return ok(app.accounts.list().find((account) => account.id === created.id)!, 201);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    return fail(error, "CREATE_ACCOUNT_FAILED", code === "ACCOUNT_APP_ID_EXISTS" ? 409 : 400);
  }
}
