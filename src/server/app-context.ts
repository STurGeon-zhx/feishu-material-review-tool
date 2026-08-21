import { resolve } from "node:path";
import { AccountRuntimeRegistry } from "./accounts/account-runtime";
import { AccountService, bootstrapLegacyWorkspace } from "./accounts/account-service";
import { readConfig } from "./config";
import { getDatabase } from "./db/client";
import { clearDestinationRebuildLocks, recoverInterruptedAssets } from "./db/repository";
import { TenantTokenProvider } from "./feishu/tenant-token";
import { CredentialCipher, loadOrCreateCredentialKey } from "./security/credential-cipher";
import { TaskSheetManager } from "./sheets/task-sheet-manager";
import { TaskService } from "./tasks/task-service";
import { SheetBatchFinalizer } from "./uploads/finalize-sheet-batch";

let context: ReturnType<typeof createContext> | undefined;

function createContext() {
  const config = readConfig();
  const database = getDatabase();
  clearDestinationRebuildLocks(database.db);
  recoverInterruptedAssets(database.db);
  const cipher = new CredentialCipher(loadOrCreateCredentialKey(resolve(config.credentialKeyPath)));
  bootstrapLegacyWorkspace(database.db, cipher, process.env);
  const accounts = new AccountService(
    database.db,
    cipher,
    async (appId, appSecret) => { await new TenantTokenProvider({ appId, appSecret }).getToken(); },
  );
  const accountRuntimes = new AccountRuntimeRegistry((accountId) => accounts.getCredentials(accountId));
  const createSheetsService = (accountId: string) => accountRuntimes.createSheetsService(accountId);
  const taskSheetManager = new TaskSheetManager(database.db, createSheetsService);
  const tasks = new TaskService(database.db, accounts, createSheetsService, taskSheetManager);
  return {
    config,
    database,
    cipher,
    accounts,
    accountRuntimes,
    createSheetsService,
    taskSheetManager,
    tasks,
    sheetFinalizer: new SheetBatchFinalizer(database.db, createSheetsService),
  };
}

export function getAppContext() {
  context ??= createContext();
  return context;
}
