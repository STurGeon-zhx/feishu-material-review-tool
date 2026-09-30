"use client";

import { useState } from "react";
import packageInfo from "../../package.json";
import type { UpdateResult } from "@/server/updates/check-update";
import { reviewApi } from "./review-api";
import styles from "./ReviewDemo.module.css";

export function UpdateChecker() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateResult | null>(null);
  const [error, setError] = useState("");

  async function check() {
    setChecking(true);
    setError("");
    setResult(null);
    try {
      setResult(await reviewApi<UpdateResult>("/api/updates", { cache: "no-store" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "检查更新失败，请稍后重试");
    } finally {
      setChecking(false);
    }
  }

  return <div className={styles.updateChecker}>
    <div><strong>当前版本 v{packageInfo.version}</strong><button disabled={checking} onClick={() => void check()}>{checking ? "检查中…" : "检查更新"}</button></div>
    {result?.status === "up_to_date" && <small>已是最新版</small>}
    {result?.status === "unavailable" && <small>暂无可公开访问的发布版本，无法比较。</small>}
    {result?.status === "update_available" && <small>发现新版本 {result.latestVersion} · <a href={result.downloadUrl ?? result.releaseUrl} target="_blank" rel="noopener noreferrer">{result.downloadUrl ? "下载新版本" : "查看发布页"}</a></small>}
    {error && <small role="alert">{error}</small>}
  </div>;
}
