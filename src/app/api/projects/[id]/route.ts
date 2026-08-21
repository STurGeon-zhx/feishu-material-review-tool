import { ok, fail } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";
import { getCurrentDestination, getProjectAssets, getProjectChecks, getSheetTabByDate } from "@/server/db/repository";
import { toAssetDto, toDestinationDto } from "@/server/projects/destination-dto";
import { formatLocalDate } from "@/server/sheets/daily-sheet-manager";
import { calculateOverallStatus } from "@/server/verification/summary";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { database } = getAppContext();
    const project = getCurrentDestination(database.db);
    if (!project || project.id !== id) return fail(new Error("审核表不存在"), "DESTINATION_NOT_FOUND", 404);
    const projectAssets = getProjectAssets(database.db, id);
    const checks = getProjectChecks(database.db, id);
    const currentSheetName = getSheetTabByDate(database.db, id, formatLocalDate(new Date()))?.sheetName;
    return ok({
      project: toDestinationDto(project, currentSheetName),
      assets: projectAssets.map(toAssetDto),
      checks,
      overallStatus: calculateOverallStatus(checks),
    });
  } catch (error) {
    return fail(error, "GET_PROJECT_FAILED");
  }
}
