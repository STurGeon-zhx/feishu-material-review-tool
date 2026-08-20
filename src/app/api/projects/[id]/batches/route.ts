import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";
import { registerBatch } from "@/server/db/repository";

const schema = z.object({
  files: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), type: z.string(), size: z.number().int().positive() })).min(1),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const input = schema.parse(await request.json());
    const batchId = randomUUID();
    const rows = registerBatch(getAppContext().database.db, id, batchId, input.files);
    return ok({ batchId, batchNumber: rows[0].batchNumber, assets: rows }, 201);
  } catch (error) {
    return fail(error, "CREATE_BATCH_FAILED", 400);
  }
}
