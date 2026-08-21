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
    const destination = await app.destinationManager.rebuild(createKey);
    const sheetName = getSheetTabByDate(
      app.database.db,
      destination.id,
      formatLocalDate(new Date()),
    )?.sheetName;
    return ok(toDestinationDto(destination, sheetName), 201);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    const status = new Set([
      "DESTINATION_MUTATION_IN_PROGRESS",
      "DESTINATION_HAS_PENDING_IMPORTS",
      "DESTINATION_NOT_INITIALIZED",
    ]).has(code) ? 409 : 502;
    return fail(error, "REBUILD_DESTINATION_FAILED", status);
  }
}
