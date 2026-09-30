import { describe, expect, it, vi } from "vitest";
import { checkUpdate } from "./check-update";

const releaseUrl = "https://github.com/STurGeon-zhx/feishu-material-review-tool/releases/tag/v0.3.0";
const downloadUrl = "https://github.com/STurGeon-zhx/feishu-material-review-tool/releases/download/v0.3.0/tool.zip";

function release(tag: string, assets: unknown[] = []) {
  return new Response(JSON.stringify({ tag_name: tag, html_url: releaseUrl, assets }), { status: 200 });
}

describe("检查工具版本更新", () => {
  it("仅把更高的语义版本识别为更新，并优先提供绿色版下载", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(release("v0.3.0", [{
      name: "飞书客户素材审核工具-win-x64-v0.3.0.zip", browser_download_url: downloadUrl,
    }]));
    await expect(checkUpdate("0.2.0", fetcher)).resolves.toEqual({
      status: "update_available", currentVersion: "0.2.0", latestVersion: "v0.3.0",
      releaseUrl, downloadUrl,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/repos/STurGeon-zhx/feishu-material-review-tool/releases/latest",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("相同或更低版本不会误报更新", async () => {
    await expect(checkUpdate("0.2.0", vi.fn<typeof fetch>().mockResolvedValue(release("v0.2.0"))))
      .resolves.toMatchObject({ status: "up_to_date" });
    await expect(checkUpdate("0.2.0", vi.fn<typeof fetch>().mockResolvedValue(release("v0.1.9"))))
      .resolves.toMatchObject({ status: "up_to_date" });
  });

  it("无公开 Release 或版本号无法解析时不声称已是最新版", async () => {
    await expect(checkUpdate("0.2.0", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }))))
      .resolves.toEqual({ status: "unavailable", currentVersion: "0.2.0" });
    await expect(checkUpdate("0.2.0", vi.fn<typeof fetch>().mockResolvedValue(release("latest"))))
      .resolves.toEqual({ status: "unavailable", currentVersion: "0.2.0" });
  });

  it("没有绿色版附件时仍可打开发布页，接口限流则提示错误", async () => {
    await expect(checkUpdate("0.2.0", vi.fn<typeof fetch>().mockResolvedValue(release("v0.3.0"))))
      .resolves.toMatchObject({ status: "update_available", downloadUrl: null, releaseUrl });
    await expect(checkUpdate("0.2.0", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }))))
      .rejects.toThrow("GitHub HTTP 403");
  });
});
