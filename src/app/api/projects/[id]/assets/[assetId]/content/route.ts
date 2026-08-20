import { join } from "node:path";
import { tmpdir } from "node:os";
import { ok, fail } from "@/server/api-response";
import { getAppContext } from "@/server/app-context";
import { getAsset, getProject, updateAsset, upsertVerification } from "@/server/db/repository";
import { FeishuHttpClient } from "@/server/feishu/http-client";
import { FeishuUploader } from "@/server/feishu/uploader";
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

export async function PUT(request: Request, context: { params: Promise<{ id: string; assetId: string }> }) {
  const { id, assetId } = await context.params;
  const app = getAppContext();
  const asset = getAsset(app.database.db, assetId);
  const project = getProject(app.database.db, id);
  if (!asset || asset.projectId !== id || !project) return fail(new Error("素材或项目不存在"), "ASSET_NOT_FOUND", 404);
  if (asset.fileToken) return ok(asset);
  if (!project.appToken || project.setupStatus !== "ready") {
    return fail(new Error("项目尚未完成飞书审核表配置"), "PROJECT_NOT_READY", 409);
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
    const accessToken = await app.auth.getValidAccessToken(project.localUserId);
    const fileToken = await new FeishuUploader(new FeishuHttpClient(accessToken)).upload(
      received.filePath,
      asset.fileName,
      project.appToken,
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
        projectId: id,
        checkKey,
        source: "automatic",
        status: "pass",
        evidenceJson: JSON.stringify({ assetId, fileToken, size: asset.fileSize, mimeType: asset.mimeType }),
        checkedAt: new Date().toISOString(),
      });
    }
    return ok(updated);
  } catch (error) {
    updateAsset(app.database.db, assetId, {
      status: "failed",
      errorCode: typeof error === "object" && error && "code" in error ? String(error.code) : "UPLOAD_FAILED",
      errorMessage: error instanceof Error ? error.message : "上传失败",
      feishuRequestId:
        typeof error === "object" && error && "feishuRequestId" in error && typeof error.feishuRequestId === "string"
          ? error.feishuRequestId
          : null,
    });
    return fail(error, "UPLOAD_FAILED", 502);
  } finally {
    await received?.cleanup();
  }
}
