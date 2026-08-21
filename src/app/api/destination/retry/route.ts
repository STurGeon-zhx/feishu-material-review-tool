import { fail, ok } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";
import { getSheetTabByDate } from "@/server/db/repository";
import { toDestinationDto } from "@/server/projects/destination-dto";
import { formatLocalDate } from "@/server/sheets/daily-sheet-manager";

export async function POST() {
  try {
    const app = getAppContext();
    const destination = await app.destinationManager.retry();
    const sheetName = getSheetTabByDate(
      app.database.db,
      destination.id,
      formatLocalDate(new Date()),
    )?.sheetName;
    return ok(toDestinationDto(destination, sheetName));
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    const status = new Set([
      "DESTINATION_MUTATION_IN_PROGRESS",
      "DESTINATION_RETRY_NOT_AVAILABLE",
    ]).has(code) ? 409 : 502;
    return fail(error, "RETRY_DESTINATION_FAILED", status);
  }
}
