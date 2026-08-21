// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filesForNewBatch, ReviewDemo } from "./ReviewDemo";

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

  it("恢复账号、任务和上次选中的工作表，并保留导入与验证区", async () => {
    vi.stubGlobal("fetch", workspaceFetcher());
    render(<ReviewDemo />);
    expect(await screen.findByRole("heading", { name: "默认任务" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "飞书账号" })).toHaveValue("account-1");
    expect(screen.getByText("0821素材审核")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /导入到「0821素材审核」/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "同步记录" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "能力验证" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开审核表" })).toHaveAttribute("href", task.spreadsheetUrl);
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
