import { fail, ok } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";
import { getSheetTabByDate } from "@/server/db/repository";
import { toDestinationDto } from "@/server/projects/destination-dto";
import { formatLocalDate } from "@/server/sheets/daily-sheet-manager";

export async function GET() {
  try {
    const app = getAppContext();
    let destination = app.destinationManager.getCurrent();
    if (destination && app.destinationManager.getActive()?.id === destination.id) {
      await app.sheetFinalizer.resumeProject(destination.id);
      destination = app.destinationManager.getCurrent();
    }
    const sheetName = destination
      ? getSheetTabByDate(app.database.db, destination.id, formatLocalDate(new Date()))?.sheetName
      : undefined;
    return ok({
      status: destination?.setupStatus ?? "uninitialized",
      destination: destination ? toDestinationDto(destination, sheetName) : null,
    });
  } catch (error) {
    return fail(error, "GET_DESTINATION_FAILED", 500);
  }
}
