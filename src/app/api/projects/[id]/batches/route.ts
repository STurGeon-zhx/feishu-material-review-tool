import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";
import { canRegisterDestinationBatch, registerBatch } from "@/server/db/repository";
import { toAssetDto } from "@/server/projects/destination-dto";

const schema = z.object({
  files: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), type: z.string(), size: z.number().int().positive() })).min(1),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const input = schema.parse(await request.json());
    const db = getAppContext().database.db;
    if (!canRegisterDestinationBatch(db, id)) {
      return fail(new Error("当前审核表不可登记新批次"), "DESTINATION_NOT_ACCEPTING_BATCHES", 409);
    }
    const batchId = randomUUID();
    const rows = registerBatch(db, id, batchId, input.files);
    return ok({ batchId, batchNumber: rows[0].batchNumber, assets: rows.map(toAssetDto) }, 201);
  } catch (error) {
    return fail(error, "CREATE_BATCH_FAILED", 400);
  }
}
