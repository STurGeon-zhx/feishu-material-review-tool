"use client";

import { useMemo, useState } from "react";
import type { Check } from "./review-workspace-types";
import styles from "./ReviewDemo.module.css";

const CHECKS = [
  ["create_spreadsheet", "创建任务电子表格"],
  ["configure_review_sheet", "配置命名审核工作表"],
  ["upload_jpg", "上传 JPG"],
  ["upload_png", "上传 PNG"],
  ["upload_video_small", "上传 ≤20MB 视频"],
  ["upload_video_50mb", "上传约 50MB 视频"],
  ["upload_video_200mb", "上传约 200MB 视频"],
  ["sheet_attachment_readback", "附件单元格回读"],
  ["sheet_batch_write", "批量写入工作表"],
  ["share_permission", "设置并回读分享权限"],
  ["share_link", "生成固定分享链接"],
  ["anonymous_view", "匿名访问审核表"],
  ["anonymous_edit", "匿名修改审核内容"],
  ["second_batch_same_link", "第二批追加且链接不变"],
] as const;

interface Props {
  checks: Check[];
  overallStatus: "pending" | "pass" | "partial" | "fail";
  spreadsheetUrl: string | null;
  onManual(key: "anonymous_view" | "anonymous_edit", status: "pass" | "fail", note: string): Promise<void>;
}

export function VerificationPanel({ checks, overallStatus, spreadsheetUrl, onManual }: Props) {
  const map = useMemo(() => new Map(checks.map((check) => [check.checkKey, check])), [checks]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  return <section className={styles.card}>
    <div className={styles.sectionTitle}><span>06</span><div><h2>能力验证</h2><p>自动证据按任务保存，匿名访问和编辑由人工登记。</p></div><strong className={`${styles.overall} ${styles[overallStatus]}`}>{overallStatus.toUpperCase()}</strong></div>
    <div className={styles.checkGrid}>{CHECKS.map(([key, label]) => {
      const check = map.get(key);
      const manual = key === "anonymous_view" || key === "anonymous_edit";
      const note = notes[key] ?? check?.note ?? "";
      return <div className={styles.checkRow} key={key}><div><span className={`${styles.checkIcon} ${check?.status === "pass" ? styles.iconPass : check?.status === "fail" ? styles.iconFail : ""}`}>{check?.status === "pass" ? "✓" : check?.status === "fail" ? "×" : "·"}</span><strong>{label}</strong></div><span>{check?.status?.toUpperCase() ?? "PENDING"}</span>{manual && <div className={styles.manual}><input placeholder="无痕测试备注" value={note} onChange={(event) => setNotes((current) => ({ ...current, [key]: event.target.value }))} /><button onClick={() => void onManual(key, "pass", note).catch(() => undefined)}>PASS</button><button className={styles.failButton} onClick={() => void onManual(key, "fail", note).catch(() => undefined)}>FAIL</button></div>}</div>;
    })}</div>
    {spreadsheetUrl && <div className={styles.guide}><strong>匿名验证步骤</strong><span>复制链接 → 打开无痕窗口 → 查看素材 → 修改审核状态 → 填写客户意见 → 回到此页登记结果</span></div>}
  </section>;
}
