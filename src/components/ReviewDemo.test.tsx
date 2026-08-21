// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filesForNewBatch, ReviewDemo } from "./ReviewDemo";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("飞书客户素材审核单页", () => {
  it("新批次只提交尚未同步的文件", () => {
    const files = [
      { id: "done", status: "completed" },
      { id: "new", status: "queued" },
      { id: "failed", status: "failed" },
    ];

    expect(filesForNewBatch(files)).toEqual([{ id: "new", status: "queued" }]);
  });

  it("展示固定审核电子表格、一键导入、同步记录和完整验证区", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { status: "uninitialized", destination: null } })),
    ));

    render(<ReviewDemo />);

    expect(screen.getByRole("heading", { name: "飞书客户素材审核 POC" })).toBeInTheDocument();
    expect(await screen.findByText("应用身份模式")).toBeInTheDocument();
    expect(screen.queryByText("连接飞书")).not.toBeInTheDocument();
    expect(screen.queryByText("新项目名称")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "固定审核电子表格" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "上传审核素材" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "一键导入到审核表" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "同步记录" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "飞书能力验证" })).toBeInTheDocument();
    expect(screen.getByText("创建电子表格")).toBeInTheDocument();
    expect(screen.getByText("写入附件单元格")).toBeInTheDocument();
    expect(screen.queryByText(/Base|多维表格/)).not.toBeInTheDocument();
  });

  it("首次导入会先确保固定审核表", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { status: "uninitialized", destination: null } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        error: { code: "ENSURE_DESTINATION_FAILED", message: "测试中止", retryable: false },
      }), { status: 502 }));
    vi.stubGlobal("fetch", fetcher);
    const { container } = render(<ReviewDemo />);
    await screen.findByText("应用身份模式");
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["video"], "one.mp4", { type: "video/mp4" })] } });
    fireEvent.click(screen.getByRole("button", { name: "一键导入到审核表" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      "/api/destination/ensure",
      expect.objectContaining({ method: "POST" }),
    ));
  });

  it("取消重建确认时不会调用重建接口", async () => {
    const destination = {
      id: "destination-1",
      name: "客户素材审核",
      requestedShareMode: "anyone_editable",
      effectiveShareMode: "anyone_editable",
      resourceType: "sheet",
      spreadsheetUrl: "https://example.feishu.cn/sheets/sht1",
      currentSheetName: "0821素材审核",
      setupStatus: "ready",
      setupStep: "ready",
      errorMessage: null,
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { status: "ready", destination } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        data: { project: destination, assets: [], checks: [], overallStatus: "pending" },
      })));
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ReviewDemo />);
    await screen.findByRole("link", { name: "打开审核表" });
    expect(screen.getByText("当前工作表：0821素材审核")).toBeInTheDocument();
    expect(screen.queryByText(/Base|多维表格/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重建审核表" }));

    expect(window.confirm).toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalledWith(
      "/api/destination/rebuild",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
