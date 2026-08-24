"use client";

import { useEffect, useState } from "react";
import type { AccountSummary } from "./review-workspace-types";
import styles from "./ReviewDemo.module.css";

interface Props {
  accounts: AccountSummary[];
  activeAccountId: string | null;
  disabled: boolean;
  onActivate(id: string): Promise<void>;
  onCreate(input: { name: string; appId: string; appSecret: string }): Promise<void>;
  onUpdate(id: string, input: { name?: string; appSecret?: string }): Promise<void>;
  onDelete(id: string): Promise<void>;
}

export function AccountSwitcher({ accounts, activeAccountId, disabled, onActivate, onCreate, onUpdate, onDelete }: Props) {
  const [showCreate, setShowCreate] = useState(accounts.length === 0);
  const [showEdit, setShowEdit] = useState(false);
  const [name, setName] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const active = accounts.find((account) => account.id === activeAccountId);

  useEffect(() => {
    setShowCreate(accounts.length === 0);
  }, [accounts.length]);

  async function create() {
    try {
      await onCreate({ name, appId, appSecret });
      setName(""); setAppId(""); setAppSecret(""); setShowCreate(false);
    } catch { /* 父组件已展示统一错误 */ }
  }

  async function update() {
    if (!active) return;
    try {
      await onUpdate(active.id, { name: name || undefined, appSecret: appSecret || undefined });
      setName(""); setAppSecret(""); setShowEdit(false);
    } catch { /* 父组件已展示统一错误 */ }
  }

  return <section className={styles.accountBar}>
    <div className={styles.accountHeading}>
      <span className={styles.stepBadge}>01</span>
      <div><strong>飞书应用账号</strong><small>应用身份 · 无需 OAuth 或机器人</small></div>
    </div>
    {accounts.length > 0 && <select
      aria-label="飞书账号"
      value={activeAccountId ?? ""}
      disabled={disabled}
      onChange={(event) => void onActivate(event.target.value).catch(() => undefined)}
    >{accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.appIdMasked}</option>)}</select>}
    <div className={styles.compactActions}>
      <button className={styles.secondary} disabled={disabled} onClick={() => { setShowCreate((value) => !value); setShowEdit(false); }}>添加账号</button>
      {active && <button className={styles.secondary} disabled={disabled} onClick={() => { setShowEdit((value) => !value); setShowCreate(false); }}>更新凭证</button>}
      {active && <button className={styles.dangerButton} disabled={disabled} onClick={() => {
        if (window.confirm(`确认删除账号记录「${active.name}」吗？\n\n该账号下的本地任务和素材记录会一起删除，飞书中的电子表格不会删除。`)) {
          void onDelete(active.id).catch(() => undefined);
        }
      }}>删除账号记录</button>}
    </div>
    {(showCreate || showEdit) && <div className={styles.credentialForm}>
      <label>账号名称<input value={name} maxLength={50} placeholder={showEdit ? active?.name : "例如：客户 A 飞书"} onChange={(event) => setName(event.target.value)} /></label>
      {showCreate && <label>App ID<input value={appId} placeholder="cli_xxx" onChange={(event) => setAppId(event.target.value)} /></label>}
      <label>App Secret<input type="password" autoComplete="new-password" value={appSecret} placeholder={showEdit ? "留空表示不修改" : "仅发送到本地服务端"} onChange={(event) => setAppSecret(event.target.value)} /></label>
      <button disabled={disabled || (showCreate ? !name.trim() || !appId.trim() || !appSecret : !name.trim() && !appSecret)} onClick={() => void (showCreate ? create() : update())}>{showCreate ? "验证并保存" : "验证并更新"}</button>
    </div>}
  </section>;
}
