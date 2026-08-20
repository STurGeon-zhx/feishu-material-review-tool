const DEFAULT_BATCH_SIZE = 200;

export function chunkRecords<T>(records: readonly T[], batchSize = DEFAULT_BATCH_SIZE): T[][] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error("批次大小必须是正整数");
  const chunks: T[][] = [];
  for (let index = 0; index < records.length; index += batchSize) {
    chunks.push(records.slice(index, index + batchSize));
  }
  return chunks;
}

export function formatMaterialNumber(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence <= 0) throw new Error("素材序号必须是正整数");
  return String(sequence).padStart(3, "0");
}
