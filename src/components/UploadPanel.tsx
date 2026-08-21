"use client";

import type { SelectedFile } from "./review-workspace-types";
import styles from "./ReviewDemo.module.css";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

interface Props {
  files: SelectedFile[];
  targetSheetName: string | null;
  busy: boolean;
  onFiles(files: FileList | File[]): void;
  onSynchronize(): Promise<void>;
  onRetry(): Promise<void>;
}

export function UploadPanel({ files, targetSheetName, busy, onFiles, onSynchronize, onRetry }: Props) {
  const queued = files.filter((file) => file.status === "queued").length;
  const retryable = files.some((file) => file.status === "failed" && file.batchId);
  return <section className={styles.card}>
    <div className={styles.sectionTitle}><span>04</span><div><h2>上传审核素材</h2><p>支持 JPG、PNG、MP4；超过 20MB 自动分片，单文件最大 2GB。</p></div></div>
    <label className={styles.dropZone} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); onFiles(event.dataTransfer.files); }}>
      <input type="file" multiple accept="image/jpeg,image/png,video/mp4" onChange={(event) => event.target.files && onFiles(event.target.files)} />
      <strong>拖入图片 / 视频</strong><span>或点击选择本地文件</span><small>{targetSheetName ? `将导入到：${targetSheetName}` : "请先选择目标工作表"}</small>
    </label>
    <div className={styles.fileList}>{files.map((item) => <div className={styles.fileRow} key={item.id}>
      <span className={styles.fileIcon}>▶</span><div className={styles.fileInfo}><strong>{item.file.name}</strong><span>{formatBytes(item.file.size)} · {item.status}{item.error ? ` · ${item.error}` : ""}</span><div className={styles.progress}><i style={{ width: `${item.progress}%` }} /></div></div>
    </div>)}</div>
    <div className={styles.actions}>
      <button disabled={busy || !targetSheetName || queued === 0} onClick={() => void onSynchronize().catch(() => undefined)}>一键导入到「{targetSheetName ?? "未选择"}」</button>
      {retryable && <button className={styles.secondary} disabled={busy} onClick={() => void onRetry().catch(() => undefined)}>重试失败项</button>}
      <span>{files.length ? `本次选择 ${files.length} 个文件` : "尚未选择文件"}</span>
    </div>
  </section>;
}
