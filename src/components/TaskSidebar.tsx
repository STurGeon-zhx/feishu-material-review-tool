"use client";

import { useEffect, useState } from "react";
import type { TaskSummary } from "./review-workspace-types";
import styles from "./ReviewDemo.module.css";

interface Props {
  tasks: TaskSummary[];
  activeTaskId: string | null;
  disabled: boolean;
  onActivate(id: string): Promise<void>;
  onCreate(input: { name: string; firstSheetName: string }): Promise<void>;
  onDelete(id: string): Promise<void>;
}

export function TaskSidebar({ tasks, activeTaskId, disabled, onActivate, onCreate, onDelete }: Props) {
  const [creating, setCreating] = useState(tasks.length === 0);
  const [name, setName] = useState("");
  const [sheetName, setSheetName] = useState("");

  useEffect(() => {
    setCreating(tasks.length === 0);
  }, [tasks.length]);

  async function create() {
    try {
      await onCreate({ name, firstSheetName: sheetName });
      setName(""); setSheetName(""); setCreating(false);
    } catch { /* 父组件已展示统一错误 */ }
  }

  return <aside className={styles.taskSidebar}>
    <div className={styles.sidebarHeader}><div><span className={styles.stepBadge}>02</span><strong>审核任务</strong></div><button disabled={disabled} onClick={() => setCreating((value) => !value)}>＋</button></div>
    {creating && <div className={styles.taskForm}>
      <label>任务名称<input maxLength={80} value={name} placeholder="例如：8 月客户素材" onChange={(event) => setName(event.target.value)} /></label>
      <label>首个工作表名称<input maxLength={100} value={sheetName} placeholder="例如：0827素材审核" onChange={(event) => setSheetName(event.target.value)} /></label>
      <button disabled={disabled || !name.trim() || !sheetName.trim()} onClick={() => void create()}>创建任务与表格</button>
    </div>}
    <div className={styles.taskList}>{tasks.map((task) => <div className={styles.taskItem} key={task.id}>
      <button
        disabled={disabled}
        className={`${styles.taskSelect} ${task.id === activeTaskId ? styles.activeTask : ""}`}
        onClick={() => void onActivate(task.id).catch(() => undefined)}
      ><strong>{task.name}</strong><span>{task.setupStatus} · {task.effectiveShareMode ?? "待设置权限"}</span></button>
      <button
        className={styles.taskDelete}
        aria-label={`删除任务 ${task.name}`}
        title="删除本地任务记录"
        disabled={disabled}
        onClick={() => {
          if (window.confirm(`确认删除任务「${task.name}」吗？\n\n本地工作表和素材记录会一起删除，飞书中的电子表格不会删除。`)) {
            void onDelete(task.id).catch(() => undefined);
          }
        }}
      >删除</button>
    </div>)}</div>
    {!creating && tasks.length === 0 && <p className={styles.empty}>创建第一个审核任务。</p>}
  </aside>;
}
