// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filesAfterSelection, filesForNewBatch, ReviewDemo } from "./ReviewDemo";
import { UploadPanel } from "./UploadPanel";
import type { SelectedFile } from "./review-workspace-types";

const account = {
  id: "account-1", name: "默认飞书账号", appIdMasked: "cli_aa0***cc8", validationStatus: "valid",
  lastValidatedAt: "2026-08-21T00:00:00.000Z", activeTaskId: "task-1", isActive: true,
};
const task = {
  id: "task-1", accountId: "account-1", name: "默认任务",
  spreadsheetUrl: "https://example.feishu.cn/sheets/sht1", effectiveShareMode: "anyone_editable",
  activeTaskSheetId: "sheet-1", setupStatus: "ready", setupStep: "ready", errorMessage: null,
};
const detail = {
  task,
  sheets: [{ id: "sheet-1", name: "0821素材审核", sheetId: "remote-1", setupStatus: "ready", setupError: null, nextRow: 75 }],
  assets: [], checks: [], overallStatus: "pending",
};

function json(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify({ ok: true, data }), { status }));
}

function workspaceFetcher() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/accounts") return json({ accounts: [account], activeAccountId: account.id });
    if (url === "/api/tasks") return json({ tasks: [task], activeTaskId: task.id });
    if (url === "/api/tasks/task-1") return json(detail);
    return json({});
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("可复用飞书素材审核工具", () => {
  it("新批次只提交尚未同步的文件", () => {
    const files = [
      { id: "done", status: "completed" },
      { id: "new", status: "queued" },
      { id: "failed", status: "failed" },
    ];
    expect(filesForNewBatch(files)).toEqual([{ id: "new", status: "queued" }]);
  });

  it("上一批全部完成后选择新素材时只展示新批次", () => {
    const previous: SelectedFile[] = [
      { id: "done-1", file: new File(["a"], "上一批-1.jpg", { type: "image/jpeg" }), status: "completed", progress: 100 },
      { id: "done-2", file: new File(["b"], "上一批-2.mp4", { type: "video/mp4" }), status: "completed", progress: 100 },
    ];
    const next = filesAfterSelection(
      previous,
      [new File(["c"], "新一批.png", { type: "image/png" })],
      () => "new-file",
    );
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: "new-file", status: "queued", progress: 0 });
    expect(next[0].file.name).toBe("新一批.png");
  });

  it("上一批存在失败项时继续保留以便重试", () => {
    const failed: SelectedFile = {
      id: "failed", file: new File(["a"], "失败.mp4", { type: "video/mp4" }),
      status: "failed", progress: 45, batchId: "batch-1",
    };
    const next = filesAfterSelection(
      [failed],
      [new File(["b"], "新增.jpg", { type: "image/jpeg" })],
      () => "new-file",
    );
    expect(next.map((file) => file.id)).toEqual(["failed", "new-file"]);
  });

  it("素材区使用统计、整体进度和可滚动队列结构", () => {
    const files: SelectedFile[] = [
      { id: "queued", file: new File(["a"], "待上传.jpg", { type: "image/jpeg" }), status: "queued", progress: 0 },
      { id: "uploading", file: new File(["b"], "上传中.mp4", { type: "video/mp4" }), status: "uploading", progress: 50 },
      { id: "done", file: new File(["c"], "已完成.png", { type: "image/png" }), status: "completed", progress: 100 },
    ];
    render(<UploadPanel files={files} targetSheetName="审核表" busy={false} importMode="preview" onImportModeChange={vi.fn()} onFiles={vi.fn()} onSynchronize={async () => undefined} onRetry={async () => undefined} />);
    expect(screen.getByLabelText("素材上传队列")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "整体上传进度" })).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("总素材").nextElementSibling).toHaveTextContent("3");
    expect(screen.getByRole("radio", { name: "图片预览（默认）" })).toBeChecked();
  });

  it("可选择将图片作为附件导入", () => {
    const onImportModeChange = vi.fn();
    render(<UploadPanel files={[]} targetSheetName="审核表" busy={false} importMode="preview" onImportModeChange={onImportModeChange} onFiles={vi.fn()} onSynchronize={async () => undefined} onRetry={async () => undefined} />);
    fireEvent.click(screen.getByRole("radio", { name: "附件" }));
    expect(onImportModeChange).toHaveBeenCalledWith("attachment");
  });

  it("未配置账号时只显示本地应用凭证入口，不显示 OAuth 或机器人入口", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => json({ accounts: [], activeAccountId: null })));
    render(<ReviewDemo />);
    expect(screen.getByRole("heading", { name: "飞书客户素材审核工具" })).toBeInTheDocument();
    expect(await screen.findByText("飞书应用账号")).toBeInTheDocument();
    expect(screen.getByLabelText("App ID")).toBeInTheDocument();
    expect(screen.getByLabelText("App Secret")).toHaveAttribute("type", "password");
    expect(screen.queryByText("连接飞书")).not.toBeInTheDocument();
    expect(screen.queryByText("创建机器人")).not.toBeInTheDocument();
  });

  it("恢复账号、任务和上次选中的工作表，并仅保留素材导入区", async () => {
    vi.stubGlobal("fetch", workspaceFetcher());
    render(<ReviewDemo />);
    expect(await screen.findByRole("heading", { name: "默认任务" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "飞书账号" })).toHaveValue("account-1");
    expect(screen.getByText("0821素材审核")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /导入到「0821素材审核」/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "同步记录" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "能力验证" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除账号记录" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除任务 默认任务" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开审核表" })).toHaveAttribute("href", task.spreadsheetUrl);
  });

  it("确认后调用任务删除接口", async () => {
    const fetcher = workspaceFetcher();
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ReviewDemo />);
    await screen.findByRole("heading", { name: "默认任务" });
    fireEvent.click(screen.getByRole("button", { name: "删除任务 默认任务" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      "/api/tasks/task-1",
      expect.objectContaining({ method: "DELETE" }),
    ));
  });

  it("可提前命名并在同一任务内创建新工作表", async () => {
    const fetcher = workspaceFetcher();
    fetcher.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/tasks/task-1/sheets" && init?.method === "POST") {
        return json({ id: "sheet-2", name: "0827素材审核", setupStatus: "ready" }, 201);
      }
      if (url === "/api/accounts") return json({ accounts: [account], activeAccountId: account.id });
      if (url === "/api/tasks") return json({ tasks: [task], activeTaskId: task.id });
      if (url === "/api/tasks/task-1") return json(detail);
      return json({});
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ReviewDemo />);
    await screen.findByRole("heading", { name: "默认任务" });
    fireEvent.click(screen.getByRole("button", { name: "＋ 新增工作表" }));
    fireEvent.change(screen.getByPlaceholderText("提前设置工作表名称"), { target: { value: "0827素材审核" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并选中" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      "/api/tasks/task-1/sheets",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "Idempotency-Key": expect.any(String) }) }),
    ));
  });
});
