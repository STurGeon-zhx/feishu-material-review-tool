"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./ReviewDemo.module.css";

type ApiSuccess<T> = { ok: true; data: T };
type ApiFailure = { ok: false; error: { code: string; message: string; retryable: boolean } };

interface Project {
  id: string;
  name: string;
  requestedShareMode: "anyone_readable" | "anyone_editable";
  effectiveShareMode: string | null;
  feishuUrl: string | null;
  setupStatus: string;
  setupStep: string;
  errorMessage: string | null;
}

interface Asset {
  id: string;
  materialNumber: string;
  fileName: string;
  fileSize: number;
  batchNumber: number;
  status: string;
  errorMessage: string | null;
}

interface Check {
  checkKey: string;
  status: "pending" | "pass" | "fail";
  note: string | null;
}

interface ProjectDetail {
  project: Project;
  assets: Asset[];
  checks: Check[];
  overallStatus: "pending" | "pass" | "partial" | "fail";
}

interface SelectedFile {
  id: string;
  file: File;
  status: "queued" | "uploading" | "uploaded" | "completed" | "failed";
  progress: number;
  error?: string;
  batchId?: string;
}

export function filesForNewBatch<T extends { status: string }>(files: T[]): T[] {
  return files.filter((file) => file.status === "queued");
}

const CHECKS = [
  ["create_base", "创建多维表格"],
  ["create_fields", "创建审核字段"],
  ["upload_jpg", "上传 JPG"],
  ["upload_png", "上传 PNG"],
  ["upload_video_small", "上传 ≤20MB 视频"],
  ["upload_video_50mb", "上传约 50MB 视频"],
  ["upload_video_200mb", "上传约 200MB 视频"],
  ["attachment_field", "写入附件字段"],
  ["batch_create_records", "批量创建记录"],
  ["share_permission", "设置并回读分享权限"],
  ["share_link", "生成固定分享链接"],
  ["anonymous_view", "匿名访问审核表"],
  ["anonymous_edit", "匿名修改审核内容"],
  ["second_batch_same_link", "第二批追加且链接不变"],
] as const;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json()) as ApiSuccess<T> | ApiFailure;
  if (!payload.ok) throw new Error(payload.error.message);
  return payload.data;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function uploadContent(projectId: string, item: SelectedFile, onProgress: (progress: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/projects/${projectId}/assets/${item.id}/content`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      try {
        const payload = JSON.parse(xhr.responseText) as ApiSuccess<unknown> | ApiFailure;
        if (xhr.status >= 200 && xhr.status < 300 && payload.ok) resolve();
        else reject(new Error(payload.ok ? "上传失败" : payload.error.message));
      } catch {
        reject(new Error(`上传失败（HTTP ${xhr.status}）`));
      }
    };
    xhr.onerror = () => reject(new Error("网络连接中断"));
    xhr.send(item.file);
  });
}

export function ReviewDemo() {
  const [connection, setConnection] = useState<{ connected: boolean; name?: string; reconnectRequired?: boolean }>({ connected: false });
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [projectName, setProjectName] = useState("");
  const [shareMode, setShareMode] = useState<"anyone_readable" | "anyone_editable">("anyone_editable");
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [manualNotes, setManualNotes] = useState<Record<string, string>>({});

  const loadDetail = useCallback(async (projectId: string) => {
    if (!projectId) {
      setDetail(null);
      return;
    }
    const nextDetail = await api<ProjectDetail>(`/api/projects/${projectId}`);
    setDetail(nextDetail);
    return nextDetail;
  }, []);

  const loadProjects = useCallback(async () => {
    const rows = await api<Project[]>("/api/projects");
    setProjects(rows);
    return rows;
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setConnection(await api("/api/feishu/status"));
        const rows = await loadProjects();
        if (rows[0]) {
          setSelectedId(rows[0].id);
          await loadDetail(rows[0].id);
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "页面初始化失败");
      }
    })();
  }, [loadDetail, loadProjects]);

  const checks = useMemo(() => new Map(detail?.checks.map((check) => [check.checkKey, check]) ?? []), [detail]);

  async function createProject() {
    if (!projectName.trim()) return setMessage("请填写项目名称");
    setBusy(true);
    setMessage("正在创建真实飞书审核表…");
    try {
      const project = await api<Project>("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ name: projectName.trim(), shareMode }),
      });
      setSelectedId(project.id);
      setProjectName("");
      await loadProjects();
      await loadDetail(project.id);
      setMessage("审核项目已创建并连接真实飞书 Base");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建失败");
      await loadProjects();
    } finally {
      setBusy(false);
    }
  }

  function addFiles(list: FileList | File[]) {
    const allowed = new Set(["image/jpeg", "image/png", "video/mp4"]);
    const incoming = Array.from(list);
    const invalid = incoming.find((file) => !allowed.has(file.type) || file.size <= 0 || file.size > 2 * 1024 ** 3);
    if (invalid) return setMessage(`${invalid.name} 不符合 JPG、PNG、MP4 或 2GB 限制`);
    setFiles((current) => [
      ...current,
      ...incoming.map((file) => ({ id: crypto.randomUUID(), file, status: "queued" as const, progress: 0 })),
    ]);
    setMessage("");
  }

  async function synchronize() {
    const pendingFiles = filesForNewBatch(files);
    if (!selectedId || pendingFiles.length === 0) return setMessage("请先选择项目和尚未同步的素材");
    setBusy(true);
    setMessage("正在同步真实素材到飞书…");
    try {
      const batch = await api<{ batchId: string }>(`/api/projects/${selectedId}/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: pendingFiles.map(({ id, file }) => ({ id, name: file.name, type: file.type, size: file.size })) }),
      });
      setFiles((current) => current.map((row) => row.status === "queued" ? { ...row, batchId: batch.batchId } : row));
      for (const item of pendingFiles) {
        setFiles((current) => current.map((row) => (row.id === item.id ? { ...row, status: "uploading" } : row)));
        try {
          await uploadContent(selectedId, item, (progress) =>
            setFiles((current) => current.map((row) => (row.id === item.id ? { ...row, progress } : row))),
          );
          setFiles((current) => current.map((row) => (row.id === item.id ? { ...row, status: "uploaded", progress: 100 } : row)));
        } catch (error) {
          setFiles((current) =>
            current.map((row) =>
              row.id === item.id ? { ...row, status: "failed", error: error instanceof Error ? error.message : "上传失败" } : row,
            ),
          );
        }
      }
      const result = await api<{ completed: number; failed: number }>(`/api/projects/${selectedId}/batches/${batch.batchId}/finalize`, { method: "POST" });
      const refreshed = await loadDetail(selectedId);
      const assetById = new Map(refreshed?.assets.map((asset) => [asset.id, asset]) ?? []);
      setFiles((current) => current.map((row) => {
        const asset = assetById.get(row.id);
        if (asset?.status === "completed") return { ...row, status: "completed", progress: 100, error: undefined };
        if (asset?.status === "failed") return { ...row, status: "failed", error: asset.errorMessage ?? "同步失败" };
        return row;
      }));
      setMessage(result.failed === 0 ? `本批 ${result.completed} 个素材已完成同步` : `本批完成 ${result.completed} 个，失败 ${result.failed} 个，可直接重试失败项`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "同步失败");
      await loadDetail(selectedId);
    } finally {
      setBusy(false);
    }
  }

  async function retryFailedUploads() {
    if (!selectedId) return;
    const retryable = files.filter((item) => item.status === "failed" && item.batchId);
    if (retryable.length === 0) return setMessage("当前没有可重试的失败素材");
    setBusy(true);
    setMessage("正在重试失败素材…");
    try {
      for (const item of retryable) {
        setFiles((current) => current.map((row) => (row.id === item.id ? { ...row, status: "uploading", error: undefined } : row)));
        try {
          await uploadContent(selectedId, item, (progress) =>
            setFiles((current) => current.map((row) => (row.id === item.id ? { ...row, progress } : row))),
          );
          setFiles((current) => current.map((row) => (row.id === item.id ? { ...row, status: "uploaded", progress: 100 } : row)));
        } catch (error) {
          setFiles((current) => current.map((row) => row.id === item.id ? { ...row, status: "failed", error: error instanceof Error ? error.message : "上传失败" } : row));
        }
      }
      for (const batchId of new Set(retryable.map((item) => item.batchId!))) {
        await api(`/api/projects/${selectedId}/batches/${batchId}/finalize`, { method: "POST" });
      }
      const refreshed = await loadDetail(selectedId);
      const assetById = new Map(refreshed?.assets.map((asset) => [asset.id, asset]) ?? []);
      setFiles((current) => current.map((row) => {
        const asset = assetById.get(row.id);
        if (asset?.status === "completed") return { ...row, status: "completed", progress: 100, error: undefined };
        if (asset?.status === "failed") return { ...row, status: "failed", error: asset.errorMessage ?? "同步失败" };
        return row;
      }));
      setMessage("失败素材重试完成");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "重试失败");
    } finally {
      setBusy(false);
    }
  }

  async function retryProjectSetup() {
    if (!selectedId) return;
    setBusy(true);
    try {
      await api(`/api/projects/${selectedId}/setup/retry`, { method: "POST" });
      await loadProjects();
      await loadDetail(selectedId);
      setMessage("项目配置已恢复完成");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "配置重试失败");
    } finally {
      setBusy(false);
    }
  }

  async function updateManualCheck(checkKey: "anonymous_view" | "anonymous_edit", status: "pass" | "fail") {
    if (!selectedId) return;
    try {
      await api(`/api/projects/${selectedId}/verifications/${checkKey}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, note: manualNotes[checkKey] ?? "" }),
      });
      await loadDetail(selectedId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存验证结果失败");
    }
  }

  return (
    <main className={styles.shell}>
      <header className={styles.hero}>
        <div>
          <span className={styles.eyebrow}>REAL OPENAPI PROOF</span>
          <h1>飞书客户素材审核 POC</h1>
          <p>批量上传图片与视频，写入长期复用的飞书客户审核表。</p>
        </div>
        <div className={`${styles.connection} ${connection.connected ? styles.connected : ""}`}>
          <span className={styles.dot} />
          <div>
            <strong>{connection.connected ? `已连接${connection.name ? ` · ${connection.name}` : "飞书"}` : connection.reconnectRequired ? "飞书授权已失效" : "尚未连接飞书"}</strong>
            <small>{connection.connected ? "使用当前用户身份调用 OpenAPI" : connection.reconnectRequired ? "项目数据已保留，请重新完成 OAuth" : "创建项目前需要完成一次 OAuth"}</small>
          </div>
          {!connection.connected && <a href="/api/feishu/connect">连接飞书</a>}
        </div>
      </header>

      {message && <div className={styles.notice}>{message}</div>}

      <section className={styles.card}>
        <div className={styles.sectionTitle}><span>01</span><div><h2>审核项目</h2><p>每个项目对应一个长期复用的飞书 Base。</p></div></div>
        <div className={styles.projectGrid}>
          <label>历史项目<select value={selectedId} onChange={(event) => { setSelectedId(event.target.value); void loadDetail(event.target.value); }}><option value="">请选择项目</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
          <label>新项目名称<input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="例如：8月 TikTok 广告审核" /></label>
        </div>
        <fieldset className={styles.share}><legend>分享权限</legend><label><input type="radio" checked={shareMode === "anyone_readable"} onChange={() => setShareMode("anyone_readable")} />任何获得链接的人可查看</label><label><input type="radio" checked={shareMode === "anyone_editable"} onChange={() => setShareMode("anyone_editable")} />任何获得链接的人可编辑</label></fieldset>
        <div className={styles.actions}>
          <button onClick={() => void createProject()} disabled={busy || !connection.connected}>新建飞书审核表</button>
          {detail && ["partial", "failed"].includes(detail.project.setupStatus) && <button className={styles.secondary} onClick={() => void retryProjectSetup()} disabled={busy}>重试项目配置</button>}
          {detail?.project.feishuUrl && <><a className={styles.secondary} href={detail.project.feishuUrl} target="_blank" rel="noreferrer">打开审核表</a><button className={styles.secondary} onClick={() => void navigator.clipboard.writeText(detail.project.feishuUrl!).then(() => setMessage("公开链接已复制"), () => setMessage("复制失败，请手动复制链接"))}>复制公开链接</button></>}
        </div>
        {detail && <div className={styles.projectMeta}><span>状态：{detail.project.setupStatus}</span><span>请求权限：{detail.project.requestedShareMode}</span><span>实际权限：{detail.project.effectiveShareMode ?? "待设置"}</span><span>素材：{detail.assets.length}</span></div>}
      </section>

      <section className={styles.card}>
        <div className={styles.sectionTitle}><span>02</span><div><h2>上传审核素材</h2><p>支持 JPG、PNG、MP4，单文件最大 2GB。</p></div></div>
        <label className={styles.dropZone} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files); }}>
          <input type="file" multiple accept="image/jpeg,image/png,video/mp4" onChange={(event) => event.target.files && addFiles(event.target.files)} />
          <strong>拖入图片 / 视频</strong><span>或点击选择本地文件</span><small>超过 20MB 自动使用飞书分片上传</small>
        </label>
        <div className={styles.fileList}>{files.map((item) => <div className={styles.fileRow} key={item.id}><div className={styles.fileIcon}>{item.file.type.startsWith("video") ? "▶" : "▧"}</div><div className={styles.fileInfo}><strong>{item.file.name}</strong><span>{formatBytes(item.file.size)} · {item.status}{item.error ? ` · ${item.error}` : ""}</span>{item.status === "uploading" && <div className={styles.progress}><i style={{ width: `${item.progress}%` }} /></div>}</div></div>)}</div>
        <div className={styles.actions}><button onClick={() => void synchronize()} disabled={busy || !selectedId || filesForNewBatch(files).length === 0}>同步到飞书</button>{files.some((item) => item.status === "failed" && item.batchId) && <button className={styles.secondary} onClick={() => void retryFailedUploads()} disabled={busy}>重试失败项</button>}<span>{files.length ? `本次选择 ${files.length} 个文件` : "尚未选择文件"}</span></div>
      </section>

      <section className={styles.card}>
        <div className={styles.sectionTitle}><span>03</span><div><h2>同步记录</h2><p>成功项保留，失败项不会造成重复记录。</p></div></div>
        <div className={styles.syncList}>{detail?.assets.length ? detail.assets.map((asset) => <div className={styles.syncRow} key={asset.id}><span className={asset.status === "completed" ? styles.passMark : styles.waitMark}>{asset.status === "completed" ? "✓" : "·"}</span><strong>{asset.materialNumber} · {asset.fileName}</strong><span>第 {asset.batchNumber} 批</span><em>{asset.status}{asset.errorMessage ? ` · ${asset.errorMessage}` : ""}</em></div>) : <p className={styles.empty}>选择项目并同步素材后，这里会显示真实记录。</p>}</div>
      </section>

      <section className={styles.card}>
        <div className={styles.sectionTitle}><span>04</span><div><h2>飞书能力验证</h2><p>自动项只接受真实 OpenAPI 证据；匿名项由无痕窗口人工确认。</p></div><div className={`${styles.overall} ${styles[detail?.overallStatus ?? "pending"]}`}>{({ pass: "PASS", partial: "PARTIAL", fail: "FAIL", pending: "PENDING" } as const)[detail?.overallStatus ?? "pending"]}</div></div>
        <div className={styles.checkGrid}>{CHECKS.map(([key, label]) => { const check = checks.get(key); const manual = key === "anonymous_view" || key === "anonymous_edit"; return <div className={styles.checkRow} key={key}><div><span className={`${styles.checkIcon} ${check?.status === "pass" ? styles.iconPass : check?.status === "fail" ? styles.iconFail : ""}`}>{check?.status === "pass" ? "✓" : check?.status === "fail" ? "×" : "·"}</span><strong>{label}</strong></div><span>{check?.status?.toUpperCase() ?? "PENDING"}</span>{manual && <div className={styles.manual}><input placeholder="无痕测试备注" value={manualNotes[key] ?? check?.note ?? ""} onChange={(event) => setManualNotes((current) => ({ ...current, [key]: event.target.value }))} /><button onClick={() => void updateManualCheck(key, "pass")}>PASS</button><button className={styles.failButton} onClick={() => void updateManualCheck(key, "fail")}>FAIL</button></div>}</div>; })}</div>
        {detail?.project.feishuUrl && <div className={styles.guide}><strong>匿名验证步骤</strong><span>复制链接 → 打开浏览器无痕窗口 → 查看素材 → 修改审核状态 → 填写客户意见 → 回到此页登记结果</span></div>}
      </section>
    </main>
  );
}
