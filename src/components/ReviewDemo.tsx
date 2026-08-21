"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./ReviewDemo.module.css";

type ApiSuccess<T> = { ok: true; data: T };
type ApiFailure = { ok: false; error: { code: string; message: string; retryable: boolean } };

interface Destination {
  id: string;
  name: string;
  resourceType: "sheet";
  requestedShareMode: "anyone_readable" | "anyone_editable";
  effectiveShareMode: string | null;
  spreadsheetUrl: string | null;
  currentSheetName: string | null;
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

interface DestinationDetail {
  project: Destination;
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
  ["create_spreadsheet", "创建电子表格"],
  ["configure_review_sheet", "配置每日审核工作表"],
  ["upload_jpg", "上传 JPG"],
  ["upload_png", "上传 PNG"],
  ["upload_video_small", "上传 ≤20MB 视频"],
  ["upload_video_50mb", "上传约 50MB 视频"],
  ["upload_video_200mb", "上传约 200MB 视频"],
  ["sheet_attachment_readback", "写入附件单元格"],
  ["sheet_batch_write", "批量写入工作表"],
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

function uploadContent(destinationId: string, item: SelectedFile, onProgress: (progress: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/projects/${destinationId}/assets/${item.id}/content`);
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
  const [destination, setDestination] = useState<Destination | null>(null);
  const [destinationStatus, setDestinationStatus] = useState("uninitialized");
  const [detail, setDetail] = useState<DestinationDetail | null>(null);
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [manualNotes, setManualNotes] = useState<Record<string, string>>({});

  const loadDetail = useCallback(async (destinationId: string) => {
    const nextDetail = await api<DestinationDetail>(`/api/projects/${destinationId}`);
    setDetail(nextDetail);
    setDestination(nextDetail.project);
    setDestinationStatus(nextDetail.project.setupStatus);
    return nextDetail;
  }, []);

  const loadDestination = useCallback(async () => {
    const result = await api<{ status: string; destination: Destination | null }>("/api/destination");
    setDestinationStatus(result.status);
    setDestination(result.destination);
    if (result.destination) await loadDetail(result.destination.id);
    else setDetail(null);
    return result.destination;
  }, [loadDetail]);

  useEffect(() => {
    void loadDestination().catch((error) => setMessage(error instanceof Error ? error.message : "页面初始化失败"));
  }, [loadDestination]);

  const checks = useMemo(() => new Map(detail?.checks.map((check) => [check.checkKey, check]) ?? []), [detail]);

  async function ensureDestination() {
    const next = await api<Destination>("/api/destination/ensure", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    setDestination(next);
    setDestinationStatus(next.setupStatus);
    return next;
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
    if (pendingFiles.length === 0) return setMessage("请选择尚未同步的素材");
    setBusy(true);
    setMessage(destination ? "正在追加素材到固定审核电子表格…" : "正在创建固定审核电子表格并导入素材…");
    try {
      const target = await ensureDestination();
      const batch = await api<{ batchId: string }>(`/api/projects/${target.id}/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: pendingFiles.map(({ id, file }) => ({ id, name: file.name, type: file.type, size: file.size })) }),
      });
      setFiles((current) => current.map((row) => row.status === "queued" ? { ...row, batchId: batch.batchId } : row));
      for (const item of pendingFiles) {
        setFiles((current) => current.map((row) => row.id === item.id ? { ...row, status: "uploading" } : row));
        try {
          await uploadContent(target.id, item, (progress) =>
            setFiles((current) => current.map((row) => row.id === item.id ? { ...row, progress } : row)),
          );
          setFiles((current) => current.map((row) => row.id === item.id ? { ...row, status: "uploaded", progress: 100 } : row));
        } catch (error) {
          setFiles((current) => current.map((row) => row.id === item.id
            ? { ...row, status: "failed", error: error instanceof Error ? error.message : "上传失败" }
            : row));
        }
      }
      const result = await api<{ completed: number; failed: number }>(
        `/api/projects/${target.id}/batches/${batch.batchId}/finalize`,
        { method: "POST" },
      );
      const refreshed = await loadDetail(target.id);
      const assetById = new Map(refreshed.assets.map((asset) => [asset.id, asset]));
      setFiles((current) => current.map((row) => {
        const asset = assetById.get(row.id);
        if (asset?.status === "completed") return { ...row, status: "completed", progress: 100, error: undefined };
        if (asset?.status === "failed") return { ...row, status: "failed", error: asset.errorMessage ?? "同步失败" };
        return row;
      }));
      setMessage(result.failed === 0
        ? `本批 ${result.completed} 个素材已导入固定审核电子表格`
        : `本批完成 ${result.completed} 个，失败 ${result.failed} 个，可直接重试失败项`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导入失败");
      await loadDestination().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function retryFailedUploads() {
    if (!destination) return;
    const retryable = files.filter((item) => item.status === "failed" && item.batchId);
    if (retryable.length === 0) return setMessage("当前没有可重试的失败素材");
    setBusy(true);
    setMessage("正在重试失败素材…");
    try {
      for (const item of retryable) {
        setFiles((current) => current.map((row) => row.id === item.id ? { ...row, status: "uploading", error: undefined } : row));
        try {
          await uploadContent(destination.id, item, (progress) =>
            setFiles((current) => current.map((row) => row.id === item.id ? { ...row, progress } : row)),
          );
          setFiles((current) => current.map((row) => row.id === item.id ? { ...row, status: "uploaded", progress: 100 } : row));
        } catch (error) {
          setFiles((current) => current.map((row) => row.id === item.id
            ? { ...row, status: "failed", error: error instanceof Error ? error.message : "上传失败" }
            : row));
        }
      }
      for (const batchId of new Set(retryable.map((item) => item.batchId!))) {
        await api(`/api/projects/${destination.id}/batches/${batchId}/finalize`, { method: "POST" });
      }
      const refreshed = await loadDetail(destination.id);
      const assetById = new Map(refreshed.assets.map((asset) => [asset.id, asset]));
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

  async function rebuildDestination() {
    if (!window.confirm("确定重建审核电子表格吗？旧表和旧链接会保留，但后续素材将导入新表。")) return;
    setBusy(true);
    setMessage("正在创建新的固定审核电子表格…");
    try {
      const next = await api<Destination>("/api/destination/rebuild", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      setFiles([]);
      setDestination(next);
      setDestinationStatus(next.setupStatus);
      await loadDetail(next.id);
      setMessage("已切换到新的固定审核电子表格，旧表未删除");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "重建失败，仍继续使用原审核电子表格");
      await loadDestination().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function retryDestinationSetup() {
    if (!destination) return;
    setBusy(true);
    try {
      await api("/api/destination/retry", { method: "POST" });
      await loadDestination();
      setMessage("审核表配置重试完成");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "配置重试失败");
    } finally {
      setBusy(false);
    }
  }

  async function updateManualCheck(checkKey: "anonymous_view" | "anonymous_edit", status: "pass" | "fail") {
    if (!destination) return;
    try {
      await api(`/api/projects/${destination.id}/verifications/${checkKey}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, note: manualNotes[checkKey] ?? "" }),
      });
      await loadDetail(destination.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存验证结果失败");
    }
  }

  return (
    <main className={styles.shell}>
      <header className={styles.hero}>
        <div>
          <span className={styles.eyebrow}>TENANT OPENAPI IMPORT</span>
          <h1>飞书客户素材审核 POC</h1>
          <p>无需绑定个人飞书账号，一键把图片与视频持续导入同一审核表。</p>
        </div>
        <div className={`${styles.connection} ${destination ? styles.connected : ""}`}>
          <span className={styles.dot} />
          <div>
            <strong>应用身份模式</strong>
            <small>{destination
              ? destination.setupStep === "share_permission_failed"
                ? "审核电子表格可导入，匿名编辑受企业策略限制"
                : destination.setupStatus === "ready"
                  ? "固定审核电子表格已就绪，无需用户 OAuth"
                  : "审核电子表格创建未完成，再次导入会从中断处继续"
              : "首次导入时自动创建固定审核电子表格"}</small>
          </div>
        </div>
      </header>

      {message && <div className={styles.notice}>{message}</div>}

      <section className={styles.card}>
        <div className={styles.sectionTitle}><span>01</span><div><h2>固定审核电子表格</h2><p>同一天持续追加到同一工作表，跨天自动新建工作表，重建前链接保持不变。</p></div></div>
        <div className={styles.actions}>
          {destination?.spreadsheetUrl && <>
            <a className={styles.secondary} href={destination.spreadsheetUrl} target="_blank" rel="noreferrer">打开审核表</a>
            <button className={styles.secondary} onClick={() => void navigator.clipboard.writeText(destination.spreadsheetUrl!).then(() => setMessage("公开链接已复制"), () => setMessage("复制失败，请手动复制链接"))}>复制公开链接</button>
          </>}
          <button
            className={styles.secondary}
            onClick={() => void rebuildDestination()}
            disabled={busy || !destination || (destination.setupStatus !== "ready" && destination.setupStep !== "share_permission_failed")}
          >重建审核表</button>
          {destination && destination.setupStatus !== "ready" && <button className={styles.secondary} onClick={() => void retryDestinationSetup()} disabled={busy}>重试审核表配置</button>}
          {!destination && <span>尚未创建 · 首次导入时自动完成</span>}
        </div>
        <div className={styles.projectMeta}>
          <span>运行模式：tenant_access_token</span>
          <span>状态：{destinationStatus}</span>
          {destination?.currentSheetName && <span>当前工作表：{destination.currentSheetName}</span>}
          <span>实际权限：{destination?.effectiveShareMode ?? "待创建"}</span>
          <span>素材：{detail?.assets.length ?? 0}</span>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.sectionTitle}><span>02</span><div><h2>上传审核素材</h2><p>支持 JPG、PNG、MP4，单文件最大 2GB。</p></div></div>
        <label className={styles.dropZone} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer.files); }}>
          <input type="file" multiple accept="image/jpeg,image/png,video/mp4" onChange={(event) => event.target.files && addFiles(event.target.files)} />
          <strong>拖入图片 / 视频</strong><span>或点击选择本地文件</span><small>超过 20MB 自动使用飞书分片上传</small>
        </label>
        <div className={styles.fileList}>{files.map((item) => <div className={styles.fileRow} key={item.id}><div className={styles.fileIcon}>{item.file.type.startsWith("video") ? "▶" : "▧"}</div><div className={styles.fileInfo}><strong>{item.file.name}</strong><span>{formatBytes(item.file.size)} · {item.status}{item.error ? ` · ${item.error}` : ""}</span>{item.status === "uploading" && <div className={styles.progress}><i style={{ width: `${item.progress}%` }} /></div>}</div></div>)}</div>
        <div className={styles.actions}><button onClick={() => void synchronize()} disabled={busy || filesForNewBatch(files).length === 0}>一键导入到审核表</button>{files.some((item) => item.status === "failed" && item.batchId) && <button className={styles.secondary} onClick={() => void retryFailedUploads()} disabled={busy}>重试失败项</button>}<span>{files.length ? `本次选择 ${files.length} 个文件` : "尚未选择文件"}</span></div>
      </section>

      <section className={styles.card}>
        <div className={styles.sectionTitle}><span>03</span><div><h2>同步记录</h2><p>成功项保留，失败项不会造成重复行。</p></div></div>
        <div className={styles.syncList}>{detail?.assets.length ? detail.assets.map((asset) => <div className={styles.syncRow} key={asset.id}><span className={asset.status === "completed" ? styles.passMark : styles.waitMark}>{asset.status === "completed" ? "✓" : "·"}</span><strong>{asset.materialNumber} · {asset.fileName}</strong><span>第 {asset.batchNumber} 批</span><em>{asset.status}{asset.errorMessage ? ` · ${asset.errorMessage}` : ""}</em></div>) : <p className={styles.empty}>一键导入素材后，这里会显示真实记录。</p>}</div>
      </section>

      <section className={styles.card}>
        <div className={styles.sectionTitle}><span>04</span><div><h2>飞书能力验证</h2><p>自动项只接受应用身份 OpenAPI 证据；匿名项由无痕窗口人工确认。</p></div><div className={`${styles.overall} ${styles[detail?.overallStatus ?? "pending"]}`}>{({ pass: "PASS", partial: "PARTIAL", fail: "FAIL", pending: "PENDING" } as const)[detail?.overallStatus ?? "pending"]}</div></div>
        <div className={styles.checkGrid}>{CHECKS.map(([key, label]) => { const check = checks.get(key); const manual = key === "anonymous_view" || key === "anonymous_edit"; return <div className={styles.checkRow} key={key}><div><span className={`${styles.checkIcon} ${check?.status === "pass" ? styles.iconPass : check?.status === "fail" ? styles.iconFail : ""}`}>{check?.status === "pass" ? "✓" : check?.status === "fail" ? "×" : "·"}</span><strong>{label}</strong></div><span>{check?.status?.toUpperCase() ?? "PENDING"}</span>{manual && <div className={styles.manual}><input placeholder="无痕测试备注" value={manualNotes[key] ?? check?.note ?? ""} onChange={(event) => setManualNotes((current) => ({ ...current, [key]: event.target.value }))} /><button onClick={() => void updateManualCheck(key, "pass")}>PASS</button><button className={styles.failButton} onClick={() => void updateManualCheck(key, "fail")}>FAIL</button></div>}</div>; })}</div>
        {destination?.spreadsheetUrl && <div className={styles.guide}><strong>匿名验证步骤</strong><span>复制链接 → 打开浏览器无痕窗口 → 查看素材 → 修改审核状态 → 填写客户意见 → 回到此页登记结果</span></div>}
      </section>
    </main>
  );
}
