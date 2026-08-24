"use client";

import type { SelectedFile } from "./review-workspace-types";
import styles from "./ReviewDemo.module.css";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

const STATUS_LABELS: Record<SelectedFile["status"], string> = {
  queued: "等待",
  uploading: "上传中",
  uploaded: "待写入",
  completed: "完成",
  failed: "失败",
};

function fileNote(file: SelectedFile): string {
  if (file.error) return file.error;
  if (file.status === "completed") return "已写入飞书";
  if (file.status === "uploaded") return "等待写入工作表";
  if (file.status === "uploading") return "正在上传文件";
  if (file.status === "failed") return "可重试";
  return "等待开始";
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
  const processing = files.filter((file) => file.status === "uploading" || file.status === "uploaded").length;
  const completed = files.filter((file) => file.status === "completed").length;
  const failed = files.filter((file) => file.status === "failed").length;
  const overallProgress = files.length
    ? Math.round(files.reduce((sum, file) => sum + file.progress, 0) / files.length)
    : 0;
  const retryable = files.some((file) => file.status === "failed" && file.batchId);
  return <section className={styles.card}>
    <div className={styles.sectionTitle}><span>04</span><div><h2>上传审核素材</h2><p>支持 JPG、PNG、MP4；超过 20MB 自动分片，单文件最大 2GB。</p></div></div>
    <label className={styles.dropZone} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); onFiles(event.dataTransfer.files); }}>
      <input type="file" multiple accept="image/jpeg,image/png,video/mp4" onChange={(event) => event.target.files && onFiles(event.target.files)} />
      <strong>拖入图片 / 视频</strong><span>或点击选择本地文件</span><small>{targetSheetName ? `将导入到：${targetSheetName}` : "请先选择目标工作表"}</small>
    </label>
    <div className={styles.uploadSummary}>
      {[
        ["总素材", files.length, ""],
        ["等待", queued, ""],
        ["处理中", processing, ""],
        ["完成", completed, styles.summarySuccess],
        ["失败", failed, styles.summaryFailure],
      ].map(([label, value, className]) => <div className={styles.summaryCard} key={String(label)}><span>{label}</span><strong className={String(className)}>{value}</strong></div>)}
    </div>
    <div className={styles.overallProgressLabel}><span>整体进度</span><strong>{overallProgress}%</strong></div>
    <div className={styles.overallProgress} role="progressbar" aria-label="整体上传进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={overallProgress}><i style={{ width: `${overallProgress}%` }} /></div>
    <div className={styles.uploadQueue} aria-label="素材上传队列">
      <div className={styles.queueHeader}><span>素材</span><span>状态</span><span>进度</span><span>大小</span><span>说明</span></div>
      <div className={styles.queueBody}>
        {files.length ? files.map((item) => <div className={styles.queueRow} key={item.id}>
          <div className={styles.queueFile}><span className={styles.fileType}>{item.file.type.startsWith("image/") ? "图片" : "视频"}</span><strong title={item.file.name}>{item.file.name}</strong></div>
          <span className={`${styles.statusPill} ${styles[item.status]}`}>{STATUS_LABELS[item.status]}</span>
          <div className={styles.queueProgress}><div><i style={{ width: `${item.progress}%` }} /></div><span>{item.progress}%</span></div>
          <span>{formatBytes(item.file.size)}</span>
          <em className={item.status === "failed" ? styles.errorNote : ""} title={fileNote(item)}>{fileNote(item)}</em>
        </div>) : <p className={styles.queueEmpty}>选择素材后，上传任务会显示在这里。</p>}
      </div>
    </div>
    <div className={styles.actions}>
      <button disabled={busy || !targetSheetName || queued === 0} onClick={() => void onSynchronize().catch(() => undefined)}>一键导入到「{targetSheetName ?? "未选择"}」</button>
      {retryable && <button className={styles.secondary} disabled={busy} onClick={() => void onRetry().catch(() => undefined)}>重试失败项</button>}
      <span>{files.length ? `本次选择 ${files.length} 个文件` : "尚未选择文件"}</span>
    </div>
  </section>;
}
