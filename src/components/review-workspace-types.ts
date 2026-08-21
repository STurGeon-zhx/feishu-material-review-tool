export interface AccountSummary {
  id: string;
  name: string;
  appIdMasked: string;
  validationStatus: "valid" | "invalid" | "unverified";
  lastValidatedAt: string | null;
  activeTaskId: string | null;
  isActive: boolean;
}

export interface TaskSummary {
  id: string;
  accountId: string;
  name: string;
  spreadsheetUrl: string | null;
  effectiveShareMode: string | null;
  activeTaskSheetId: string | null;
  setupStatus: string;
  setupStep: string;
  errorMessage: string | null;
}

export interface TaskSheet {
  id: string;
  name: string;
  sheetId: string | null;
  setupStatus: "creating" | "ready" | "failed";
  setupError: string | null;
  nextRow: number;
}

export interface Asset {
  id: string;
  batchId: string;
  materialNumber: string;
  fileName: string;
  fileSize: number;
  batchNumber: number;
  taskSheetId: string | null;
  status: string;
  errorMessage: string | null;
}

export interface Check {
  checkKey: string;
  status: "pending" | "pass" | "fail";
  note: string | null;
}

export interface TaskDetail {
  task: TaskSummary;
  sheets: TaskSheet[];
  assets: Asset[];
  checks: Check[];
  overallStatus: "pending" | "pass" | "partial" | "fail";
}

export interface SelectedFile {
  id: string;
  file: File;
  status: "queued" | "uploading" | "uploaded" | "completed" | "failed";
  progress: number;
  error?: string;
  batchId?: string;
}
