import { ok, fail } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";
import { getProject, getProjectAssets, getProjectChecks } from "@/server/db/repository";
import { calculateOverallStatus } from "@/server/verification/summary";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { database, config } = getAppContext();
    const project = getProject(database.db, id);
    if (!project || project.localUserId !== config.demoUserId) return fail(new Error("项目不存在"), "PROJECT_NOT_FOUND", 404);
    const projectAssets = getProjectAssets(database.db, id);
    const checks = getProjectChecks(database.db, id);
    return ok({ project, assets: projectAssets, checks, overallStatus: calculateOverallStatus(checks) });
  } catch (error) {
    return fail(error, "GET_PROJECT_FAILED");
  }
}
