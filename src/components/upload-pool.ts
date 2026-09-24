const SIMPLE_UPLOAD_LIMIT = 20 * 1024 * 1024;
const MAX_TOTAL_UPLOADS = 3;
const MAX_LARGE_UPLOADS = 2;

export interface UploadPoolItem {
  file: { size: number };
}

export async function runStableUploadPool<T extends UploadPoolItem>(
  items: readonly T[],
  operation: (item: T) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
  if (items.length === 0) return [];
  const queue = items.map((item, index) => ({ item, index }));
  const results: PromiseSettledResult<void>[] = new Array(items.length);
  let activeTotal = 0;
  let activeLarge = 0;
  let settled = 0;

  return new Promise((resolve) => {
    const schedule = () => {
      while (activeTotal < MAX_TOTAL_UPLOADS && queue.length > 0) {
        const queueIndex = queue.findIndex(({ item }) => (
          item.file.size <= SIMPLE_UPLOAD_LIMIT || activeLarge < MAX_LARGE_UPLOADS
        ));
        if (queueIndex < 0) break;

        const [{ item, index }] = queue.splice(queueIndex, 1);
        const large = item.file.size > SIMPLE_UPLOAD_LIMIT;
        activeTotal += 1;
        if (large) activeLarge += 1;

        Promise.resolve()
          .then(() => operation(item))
          .then(
            () => { results[index] = { status: "fulfilled", value: undefined }; },
            (reason: unknown) => { results[index] = { status: "rejected", reason }; },
          )
          .finally(() => {
            activeTotal -= 1;
            if (large) activeLarge -= 1;
            settled += 1;
            if (settled === items.length) resolve(results);
            else schedule();
          });
      }
    };

    schedule();
  });
}
