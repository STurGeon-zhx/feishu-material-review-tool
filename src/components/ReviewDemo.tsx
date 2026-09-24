"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AccountSwitcher } from "./AccountSwitcher";
import { SheetSelector } from "./SheetSelector";
import { TaskSidebar } from "./TaskSidebar";
import { UploadPanel } from "./UploadPanel";
import { jsonRequest, reviewApi } from "./review-api";
import type { AccountSummary, SelectedFile, TaskDetail, TaskSummary } from "./review-workspace-types";
import { runStableUploadPool } from "./upload-pool";
import styles from "./ReviewDemo.module.css";

export function filesForNewBatch<T extends { status: string }>(files: T[]): T[] {
  return files.filter((file) => file.status === "queued");
}

export function filesAfterSelection(
  current: SelectedFile[],
  incoming: File[],
  createId: () => string = () => crypto.randomUUID(),
): SelectedFile[] {
  if (incoming.length === 0) return current;
  const previousBatchCompleted = current.length > 0 && current.every((file) => file.status === "completed");
  const selected = incoming.map((file) => ({
    id: createId(),
    file,
    status: "queued" as const,
    progress: 0,
  }));
  return previousBatchCompleted ? selected : [...current, ...selected];
}

function uploadContent(taskId: string, item: SelectedFile, onProgress: (progress: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/tasks/${taskId}/assets/${item.id}/content`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      try {
        const payload = JSON.parse(xhr.responseText) as { ok: boolean; error?: { message: string } };
        if (xhr.status >= 200 && xhr.status < 300 && payload.ok) resolve();
        else reject(new Error(payload.error?.message ?? `上传失败（HTTP ${xhr.status}）`));
      } catch {
        reject(new Error(`上传失败（HTTP ${xhr.status}）`));
      }
    };
    xhr.onerror = () => reject(new Error("网络连接中断"));
    xhr.send(item.file);
  });
}

export function ReviewDemo() {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const loadTask = useCallback(async (taskId: string) => {
    const next = await reviewApi<TaskDetail>(`/api/tasks/${taskId}`);
    setDetail(next);
    setActiveTaskId(taskId);
    return next;
  }, []);

  const loadTasks = useCallback(async () => {
    const result = await reviewApi<{ tasks: TaskSummary[]; activeTaskId: string | null }>("/api/tasks");
    setTasks(result.tasks);
    const targetId = result.activeTaskId && result.tasks.some((task) => task.id === result.activeTaskId)
      ? result.activeTaskId
      : result.tasks[0]?.id ?? null;
    if (targetId) {
      if (targetId !== result.activeTaskId) await reviewApi(`/api/tasks/${targetId}/activate`, { method: "POST" });
      await loadTask(targetId);
    } else {
      setActiveTaskId(null);
      setDetail(null);
    }
  }, [loadTask]);

  const loadWorkspace = useCallback(async () => {
    const result = await reviewApi<{ accounts: AccountSummary[]; activeAccountId: string | null }>("/api/accounts");
    setAccounts(result.accounts);
    setActiveAccountId(result.activeAccountId);
    if (result.activeAccountId) await loadTasks();
    else { setTasks([]); setDetail(null); setActiveTaskId(null); }
  }, [loadTasks]);

  useEffect(() => {
    void loadWorkspace().catch((error) => setMessage(error instanceof Error ? error.message : "页面初始化失败"));
  }, [loadWorkspace]);

  const activeSheet = useMemo(() => detail?.sheets.find((sheet) => sheet.id === detail.task.activeTaskSheetId) ?? null, [detail]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : "操作失败"); throw error; }
    finally { setBusy(false); }
  }

  async function createAccount(input: { name: string; appId: string; appSecret: string }) {
    await run(async () => {
      await reviewApi("/api/accounts", jsonRequest("POST", input));
      setFiles([]); setMessage("飞书账号验证成功并已切换"); await loadWorkspace();
    });
  }

  async function updateAccount(id: string, input: { name?: string; appSecret?: string }) {
    await run(async () => {
      await reviewApi(`/api/accounts/${id}`, jsonRequest("PATCH", input));
      setMessage("账号凭证已验证并更新"); await loadWorkspace();
    });
  }

  async function deleteAccount(id: string) {
    await run(async () => {
      await reviewApi(`/api/accounts/${id}`, { method: "DELETE" });
      setFiles([]); setDetail(null); setActiveTaskId(null);
      setMessage("账号及其本地任务记录已删除，飞书文档已保留");
      await loadWorkspace();
    });
  }

  async function activateAccount(id: string) {
    if (id === activeAccountId) return;
    await run(async () => {
      await reviewApi(`/api/accounts/${id}/activate`, { method: "POST" });
      setFiles([]); setDetail(null); setActiveTaskId(null); setMessage("已切换飞书账号"); await loadWorkspace();
    });
  }

  async function createTask(input: { name: string; firstSheetName: string }) {
    try {
      await run(async () => {
        setMessage("正在创建任务电子表格和首个工作表…");
        const task = await reviewApi<TaskSummary>("/api/tasks", jsonRequest("POST", input, true));
        setFiles([]); await loadTasks(); await loadTask(task.id); setMessage("任务与首个工作表已创建");
      });
    } catch (error) {
      await loadTasks().catch(() => undefined);
      throw error;
    }
  }

  async function activateTask(id: string) {
    if (id === activeTaskId) return;
    await run(async () => {
      await reviewApi(`/api/tasks/${id}/activate`, { method: "POST" });
      setFiles([]); await loadTask(id); setMessage("已切换审核任务");
    });
  }

  async function deleteTask(id: string) {
    await run(async () => {
      await reviewApi(`/api/tasks/${id}`, { method: "DELETE" });
      setFiles([]); setDetail(null); setActiveTaskId(null);
      setMessage("本地任务记录已删除，飞书电子表格已保留");
      await loadTasks();
    });
  }

  async function createSheet(name: string) {
    if (!activeTaskId) return;
    try {
      await run(async () => {
        setMessage("正在同一电子表格中创建工作表…");
        await reviewApi(`/api/tasks/${activeTaskId}/sheets`, jsonRequest("POST", { name }, true));
        await loadTask(activeTaskId); setMessage(`工作表「${name.trim()}」已创建并选中`);
      });
    } catch (error) {
      await loadTask(activeTaskId).catch(() => undefined);
      throw error;
    }
  }

  async function activateSheet(id: string) {
    if (!activeTaskId || id === detail?.task.activeTaskSheetId) return;
    await run(async () => {
      await reviewApi(`/api/tasks/${activeTaskId}/sheets/${id}/activate`, { method: "POST" });
      setFiles([]); await loadTask(activeTaskId); setMessage("已切换目标工作表");
    });
  }

  async function retryTask() {
    if (!activeTaskId) return;
    await run(async () => {
      setMessage("正在继续配置任务…");
      await reviewApi(`/api/tasks/${activeTaskId}/retry`, { method: "POST" });
      await loadTask(activeTaskId);
      setMessage("任务配置重试完成");
    });
  }

  async function retrySheet(id: string) {
    if (!activeTaskId) return;
    await run(async () => {
      setMessage("正在继续配置工作表…");
      await reviewApi(`/api/tasks/${activeTaskId}/sheets/${id}/retry`, { method: "POST" });
      await loadTask(activeTaskId);
      setMessage("工作表配置重试完成");
    });
  }

  function addFiles(list: FileList | File[]) {
    const allowed = new Set(["image/jpeg", "image/png", "video/mp4"]);
    const incoming = Array.from(list);
    const invalid = incoming.find((file) => !allowed.has(file.type) || file.size <= 0 || file.size > 2 * 1024 ** 3);
    if (invalid) return setMessage(`${invalid.name} 不符合 JPG、PNG、MP4 或 2GB 限制`);
    setFiles((current) => filesAfterSelection(current, incoming));
    setMessage("");
  }

  async function synchronize() {
    if (!activeTaskId || !activeSheet) return setMessage("请先选择目标工作表");
    const pending = filesForNewBatch(files);
    if (pending.length === 0) return setMessage("请选择尚未同步的素材");
    await run(async () => {
      setMessage(`正在导入到「${activeSheet.name}」…`);
      const batch = await reviewApi<{ batchId: string }>(`/api/tasks/${activeTaskId}/batches`, jsonRequest("POST", {
        taskSheetId: activeSheet.id,
        files: pending.map(({ id, file }) => ({ id, name: file.name, type: file.type, size: file.size })),
      }));
      setFiles((current) => current.map((row) => row.status === "queued" ? { ...row, batchId: batch.batchId } : row));
      await runStableUploadPool(pending, async (item) => {
        setFiles((current) => current.map((row) => row.id === item.id ? { ...row, status: "uploading" } : row));
        try {
          await uploadContent(activeTaskId, item, (progress) => setFiles((current) => current.map((row) => row.id === item.id ? { ...row, progress } : row)));
          setFiles((current) => current.map((row) => row.id === item.id ? { ...row, status: "uploaded", progress: 100 } : row));
        } catch (error) {
          setFiles((current) => current.map((row) => row.id === item.id ? { ...row, status: "failed", error: error instanceof Error ? error.message : "上传失败" } : row));
        }
      });
      const result = await reviewApi<{ completed: number; failed: number }>(`/api/tasks/${activeTaskId}/batches/${batch.batchId}/finalize`, { method: "POST" });
      const refreshed = await loadTask(activeTaskId);
      const byId = new Map(refreshed.assets.map((asset) => [asset.id, asset]));
      setFiles((current) => current.map((row) => {
        const asset = byId.get(row.id);
        if (asset?.status === "completed") return { ...row, status: "completed", progress: 100, error: undefined };
        if (asset?.status === "failed") return { ...row, status: "failed", error: asset.errorMessage ?? "同步失败" };
        return row;
      }));
      setMessage(result.failed === 0 ? `本批 ${result.completed} 个素材已导入「${activeSheet.name}」` : `本批完成 ${result.completed} 个，失败 ${result.failed} 个`);
    });
  }

  async function retryFailed() {
    if (!activeTaskId) return;
    const retryable = files.filter((file) => file.status === "failed" && file.batchId);
    if (retryable.length === 0) return;
    await run(async () => {
      await runStableUploadPool(retryable, async (item) => {
        setFiles((current) => current.map((row) => row.id === item.id ? { ...row, status: "uploading", error: undefined } : row));
        try {
          await uploadContent(activeTaskId, item, (progress) => setFiles((current) => current.map((row) => row.id === item.id ? { ...row, progress } : row)));
        } catch (error) {
          setFiles((current) => current.map((row) => row.id === item.id ? { ...row, status: "failed", error: error instanceof Error ? error.message : "上传失败" } : row));
        }
      });
      for (const batchId of new Set(retryable.map((file) => file.batchId!))) {
        await reviewApi(`/api/tasks/${activeTaskId}/batches/${batchId}/finalize`, { method: "POST" });
      }
      const refreshed = await loadTask(activeTaskId);
      const byId = new Map(refreshed.assets.map((asset) => [asset.id, asset]));
      setFiles((current) => current.map((row) => {
        const asset = byId.get(row.id);
        if (asset?.status === "completed") return { ...row, status: "completed", progress: 100, error: undefined };
        if (asset?.status === "failed") return { ...row, status: "failed", error: asset.errorMessage ?? "同步失败" };
        return row;
      }));
      setMessage("失败素材重试完成");
    });
  }

  const activeAccount = accounts.find((account) => account.id === activeAccountId);
  const accountStatus = activeAccount?.validationStatus === "valid"
    ? "应用凭证已验证"
    : activeAccount ? "旧版凭证已迁移，使用时自动验证" : "添加 App ID 与 App Secret 后开始";

  return <main className={styles.shell}>
    <header className={styles.hero}><div><span className={styles.eyebrow}>REUSABLE FEISHU REVIEW WORKSPACE</span><h1>飞书客户素材审核工具</h1><p>多账号、多任务、自定义工作表，一键导入图片与视频。</p></div><div className={`${styles.connection} ${activeAccountId ? styles.connected : ""}`}><span className={styles.dot} /><div><strong>{activeAccount?.name ?? "尚未配置飞书账号"}</strong><small>{accountStatus}</small></div></div></header>
    {message && <div className={styles.notice}>{message}</div>}
    <AccountSwitcher accounts={accounts} activeAccountId={activeAccountId} disabled={busy} onActivate={activateAccount} onCreate={createAccount} onUpdate={updateAccount} onDelete={deleteAccount} />
    {activeAccountId ? <div className={styles.workspace}>
      <TaskSidebar tasks={tasks} activeTaskId={activeTaskId} disabled={busy} onActivate={activateTask} onCreate={createTask} onDelete={deleteTask} />
      <div className={styles.workspaceMain}>
        {detail ? <>
          <section className={styles.card}>
            <div className={styles.taskHero}><div><span className={styles.stepBadge}>任务</span><h2>{detail.task.name}</h2><p>同一任务的全部工作表共用此电子表格文档与分享链接。</p></div><div className={styles.compactActions}>{!(detail.task.setupStatus === "ready" || (detail.task.setupStatus === "partial" && detail.task.setupStep === "share_permission_failed")) && <button className={styles.secondary} disabled={busy} onClick={() => void retryTask().catch(() => undefined)}>重试任务配置</button>}{detail.task.spreadsheetUrl && <><a className={styles.secondary} href={detail.task.spreadsheetUrl} target="_blank" rel="noreferrer">打开审核表</a><button className={styles.secondary} onClick={() => void navigator.clipboard.writeText(detail.task.spreadsheetUrl!).then(() => setMessage("公开链接已复制")).catch(() => setMessage("复制失败，请手动复制链接"))}>复制链接</button></>}</div></div>
            <div className={styles.projectMeta}><span>状态：{detail.task.setupStatus}</span><span>权限：{detail.task.effectiveShareMode ?? "待回读"}</span><span>工作表：{detail.sheets.length}</span><span>素材：{detail.assets.length}</span></div>
            <SheetSelector sheets={detail.sheets} activeSheetId={detail.task.activeTaskSheetId} disabled={busy} onActivate={activateSheet} onCreate={createSheet} onRetry={retrySheet} />
          </section>
          <UploadPanel files={files} targetSheetName={activeSheet?.name ?? null} busy={busy} onFiles={addFiles} onSynchronize={synchronize} onRetry={retryFailed} />
        </> : <section className={styles.card}><p className={styles.empty}>请在左侧创建或选择审核任务。</p></section>}
      </div>
    </div> : <section className={styles.card}><p className={styles.empty}>先在上方添加飞书应用账号。App Secret 只会加密保存在本机。</p></section>}
  </main>;
}
