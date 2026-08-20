export const REQUIRED_CHECK_KEYS = [
  "create_base",
  "create_fields",
  "share_permission",
  "upload_jpg",
  "upload_png",
  "upload_video_small",
  "upload_video_50mb",
  "upload_video_200mb",
  "attachment_field",
  "batch_create_records",
  "share_link",
  "anonymous_view",
  "anonymous_edit",
  "second_batch_same_link",
] as const;

export type OverallStatus = "pending" | "pass" | "partial" | "fail";

export function calculateOverallStatus(
  checks: Array<{ checkKey: string; status: "pending" | "pass" | "fail" }>,
): OverallStatus {
  const statusByKey = new Map(checks.map((check) => [check.checkKey, check.status]));
  if (REQUIRED_CHECK_KEYS.some((key) => !statusByKey.has(key) || statusByKey.get(key) === "pending")) return "pending";
  if (statusByKey.get("anonymous_view") === "fail") return "fail";
  if (
    REQUIRED_CHECK_KEYS.some(
      (key) => key !== "anonymous_edit" && statusByKey.get(key) === "fail",
    )
  ) {
    return "fail";
  }
  if (statusByKey.get("anonymous_edit") === "fail") return "partial";
  return "pass";
}
