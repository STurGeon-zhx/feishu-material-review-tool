import { fail, ok } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";
import { getSheetTabByDate } from "@/server/db/repository";
import { toDestinationDto } from "@/server/projects/destination-dto";
import { formatLocalDate } from "@/server/sheets/daily-sheet-manager";

export async function POST(request: Request) {
  const createKey = request.headers.get("Idempotency-Key");
  if (!createKey) return fail(new Error("缺少 Idempotency-Key"), "IDEMPOTENCY_KEY_REQUIRED", 400);
  try {
    const app = getAppContext();
    const destination = await app.destinationManager.ensure(createKey);
    const sheetName = getSheetTabByDate(
      app.database.db,
      destination.id,
      formatLocalDate(new Date()),
    )?.sheetName;
    return ok(toDestinationDto(destination, sheetName), 201);
  } catch (error) {
    return fail(error, "ENSURE_DESTINATION_FAILED", 502);
  }
}
