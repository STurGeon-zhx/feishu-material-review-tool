import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";
import { createOrGetProject, listProjects } from "@/server/db/repository";

const inputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  shareMode: z.enum(["anyone_readable", "anyone_editable"]),
});

export async function GET() {
  try {
    const { database, config } = getAppContext();
    return ok(listProjects(database.db, config.demoUserId));
  } catch (error) {
    return fail(error, "LIST_PROJECTS_FAILED");
  }
}

export async function POST(request: Request) {
  try {
    const input = inputSchema.parse(await request.json());
    const createKey = request.headers.get("Idempotency-Key");
    if (!createKey) return fail(new Error("缺少 Idempotency-Key"), "IDEMPOTENCY_KEY_REQUIRED", 400);
    const { database, config, projectSetup } = getAppContext();
    const project = createOrGetProject(database.db, {
      id: randomUUID(),
      createKey,
      localUserId: config.demoUserId,
      name: input.name,
      requestedShareMode: input.shareMode,
    });
    const ready = await projectSetup.run(project.id);
    return ok(ready, 201);
  } catch (error) {
    return fail(error, "CREATE_PROJECT_FAILED", 502);
  }
}
