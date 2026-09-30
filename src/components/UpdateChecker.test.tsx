// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateChecker } from "./UpdateChecker";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("版本更新入口", () => {
  it("手动检查后展示新版本的下载入口", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: {
        status: "update_available", currentVersion: "0.2.0", latestVersion: "v0.3.0",
        releaseUrl: "https://github.com/STurGeon-zhx/feishu-material-review-tool/releases/tag/v0.3.0",
        downloadUrl: "https://github.com/STurGeon-zhx/feishu-material-review-tool/releases/download/v0.3.0/tool.zip",
      },
    })));
    vi.stubGlobal("fetch", fetcher);

    render(<UpdateChecker />);
    expect(screen.getByText("当前版本 v0.2.0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByRole("link", { name: "下载新版本" })).toHaveAttribute("href", "https://github.com/STurGeon-zhx/feishu-material-review-tool/releases/download/v0.3.0/tool.zip");
    expect(fetcher).toHaveBeenCalledWith("/api/updates", { cache: "no-store" });
  });
});
