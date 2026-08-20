// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filesForNewBatch, ReviewDemo } from "./ReviewDemo";

afterEach(() => vi.restoreAllMocks());

describe("飞书客户素材审核单页", () => {
  it("新批次只提交尚未同步的文件", () => {
    const files = [
      { id: "done", status: "completed" },
      { id: "new", status: "queued" },
      { id: "failed", status: "failed" },
    ];

    expect(filesForNewBatch(files)).toEqual([{ id: "new", status: "queued" }]);
  });

  it("展示连接、项目、上传、同步记录和验证五个区域", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { connected: false } })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: [] }))),
    );

    render(<ReviewDemo />);

    expect(screen.getByRole("heading", { name: "飞书客户素材审核 POC" })).toBeInTheDocument();
    expect(await screen.findByText("尚未连接飞书")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "连接飞书" })).toHaveAttribute("href", "/api/feishu/connect");
    expect(screen.getByRole("heading", { name: "审核项目" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "上传审核素材" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "同步记录" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "飞书能力验证" })).toBeInTheDocument();
  });
});
