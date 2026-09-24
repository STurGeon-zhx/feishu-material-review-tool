import { join } from "node:path";
import { tmpdir } from "node:os";
import { fail, ok } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";
import { getAsset, getProject, getTaskSheet, updateAsset, upsertVerification } from "@/server/db/repository";
import { FeishuHttpClient } from "@/server/feishu/http-client";
import { DriveAttachmentUploader, requiresSpreadsheetReupload } from "@/server/feishu/drive-attachment-uploader";
import { toTaskAssetDto } from "@/server/tasks/task-dto";
import { receiveFile } from "@/server/uploads/receive-file";

function uploadCheckKey(mimeType: string, size: number): string | undefined {
  if (mimeType === "image/jpeg") return "upload_jpg";
  if (mimeType === "image/png") return "upload_png";
  if (mimeType !== "video/mp4") return undefined;
  if (size <= 20 * 1024 * 1024) return "upload_video_small";
  if (size >= 180 * 1024 * 1024) return "upload_video_200mb";
  if (size >= 40 * 1024 * 1024 && size <= 100 * 1024 * 1024) return "upload_video_50mb";
  return undefined;
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ taskId: string; assetId: string }> },
) {
  const { taskId, assetId } = await context.params;
  const app = getAppContext();
  try {
    app.tasks.getTaskForActiveAccount(taskId);
  } catch (error) {
    return fail(error, "TASK_NOT_FOUND", 404);
  }
  const asset = getAsset(app.database.db, assetId);
  const task = getProject(app.database.db, taskId);
  const taskSheet = asset?.taskSheetId ? getTaskSheet(app.database.db, asset.taskSheetId) : undefined;
  if (!asset || asset.projectId !== taskId || !task?.accountId || !taskSheet || taskSheet.taskId !== taskId) {
    return fail(new Error("素材、任务或目标工作表不存在"), "ASSET_NOT_FOUND", 404);
  }
  if (asset.fileToken && !requiresSpreadsheetReupload(asset)) return ok(toTaskAssetDto(asset));
  const importable = task.setupStatus === "ready"
    || (task.setupStatus === "partial" && task.setupStep === "share_permission_failed");
  if (!task.spreadsheetToken || !importable || taskSheet.setupStatus !== "ready") {
    return fail(new Error("任务或目标工作表尚未配置完成"), "TASK_NOT_READY", 409);
  }

  let received: Awaited<ReturnType<typeof receiveFile>> | undefined;
  try {
    updateAsset(app.database.db, assetId, { status: "receiving", errorCode: null, errorMessage: null });
    received = await receiveFile(request, {
      directory: join(tmpdir(), "feishu-customer-review-poc"),
      declaredSize: asset.fileSize,
      declaredType: asset.mimeType,
    });
    updateAsset(app.database.db, assetId, { status: "uploading" });
    const accessToken = await app.accountRuntimes.getProvider(task.accountId).getToken();
    const fileToken = await new DriveAttachmentUploader(
      new FeishuHttpClient(accessToken),
      () => app.accountRuntimes.waitForMediaRequest(task.accountId!),
    ).upload(
      received.filePath,
      asset.fileName,
      task.spreadsheetToken,
      received.detectedType,
    );
    const updated = updateAsset(app.database.db, assetId, {
      status: "uploaded",
      fileToken,
      errorCode: null,
      errorMessage: null,
    })!;
    const checkKey = uploadCheckKey(asset.mimeType, asset.fileSize);
    if (checkKey) {
      upsertVerification(app.database.db, {
        projectId: taskId,
        checkKey,
        source: "automatic",
        status: "pass",
        evidenceJson: JSON.stringify({ assetId, size: asset.fileSize, mimeType: asset.mimeType }),
        checkedAt: new Date().toISOString(),
      });
    }
    return ok(toTaskAssetDto(updated));
  } catch (error) {
    updateAsset(app.database.db, assetId, {
      status: "failed",
      errorCode: typeof error === "object" && error && "code" in error ? String(error.code) : "UPLOAD_FAILED",
      errorMessage: error instanceof Error ? error.message : "上传失败",
      feishuRequestId: typeof error === "object" && error && "feishuRequestId" in error
        && typeof error.feishuRequestId === "string" ? error.feishuRequestId : null,
    });
    return fail(error, "UPLOAD_FAILED", 502);
  } finally {
    await received?.cleanup();
  }
}
