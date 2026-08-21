"use client";

import { useState } from "react";
import type { TaskSheet } from "./review-workspace-types";
import styles from "./ReviewDemo.module.css";

interface Props {
  sheets: TaskSheet[];
  activeSheetId: string | null;
  disabled: boolean;
  onActivate(id: string): Promise<void>;
  onCreate(name: string): Promise<void>;
  onRetry(id: string): Promise<void>;
}

export function SheetSelector({ sheets, activeSheetId, disabled, onActivate, onCreate, onRetry }: Props) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  async function create() {
    try {
      await onCreate(name);
      setName(""); setCreating(false);
    } catch { /* 父组件已展示统一错误 */ }
  }
  return <div className={styles.sheetBlock}>
    <div className={styles.sheetTitle}><div><span className={styles.stepBadge}>03</span><strong>目标工作表</strong></div><button className={styles.secondary} disabled={disabled} onClick={() => setCreating((value) => !value)}>＋ 新增工作表</button></div>
    <div className={styles.sheetTabs}>{sheets.map((sheet) => <div className={styles.sheetTab} key={sheet.id}>
      <button
        disabled={disabled || sheet.setupStatus !== "ready"}
        className={sheet.id === activeSheetId ? styles.activeSheet : ""}
        onClick={() => void onActivate(sheet.id).catch(() => undefined)}
      >{sheet.name}<small>{sheet.setupStatus === "ready" ? "可导入" : sheet.setupError ?? sheet.setupStatus}</small></button>
      {sheet.setupStatus === "failed" && <button className={styles.retryLink} disabled={disabled} onClick={() => void onRetry(sheet.id).catch(() => undefined)}>重试配置</button>}
    </div>)}</div>
    {creating && <div className={styles.inlineCreate}><input autoFocus maxLength={100} value={name} placeholder="提前设置工作表名称" onChange={(event) => setName(event.target.value)} /><button disabled={disabled || !name.trim()} onClick={() => void create()}>创建并选中</button></div>}
  </div>;
}
