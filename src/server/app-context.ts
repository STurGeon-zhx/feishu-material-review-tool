import { getDatabase } from "./db/client";
import { clearDestinationRebuildLocks, recoverInterruptedAssets } from "./db/repository";
import { readConfig } from "./config";
import { FeishuHttpClient } from "./feishu/http-client";
import { FeishuSheetsService } from "./feishu/sheets-service";
import { TenantTokenProvider } from "./feishu/tenant-token";
import { DestinationManager } from "./projects/destination-manager";
import { SpreadsheetSetup } from "./projects/spreadsheet-setup";
import { DailySheetManager } from "./sheets/daily-sheet-manager";
import { SheetBatchFinalizer } from "./uploads/finalize-sheet-batch";

let context: ReturnType<typeof createContext> | undefined;

function createContext() {
  const config = readConfig();
  const database = getDatabase();
  clearDestinationRebuildLocks(database.db);
  recoverInterruptedAssets(database.db);
  const tokenProvider = new TenantTokenProvider(config);
  const createSheetsService = async () =>
    new FeishuSheetsService(new FeishuHttpClient(await tokenProvider.getToken()));
  const sheetsApi = {
    getWorkbookInfo: async (...args: Parameters<FeishuSheetsService["getWorkbookInfo"]>) =>
      (await createSheetsService()).getWorkbookInfo(...args),
    createSheet: async (...args: Parameters<FeishuSheetsService["createSheet"]>) =>
      (await createSheetsService()).createSheet(...args),
    renameSheet: async (...args: Parameters<FeishuSheetsService["renameSheet"]>) =>
      (await createSheetsService()).renameSheet(...args),
    setCellRange: async (...args: Parameters<FeishuSheetsService["setCellRange"]>) =>
      (await createSheetsService()).setCellRange(...args),
    getCellRange: async (...args: Parameters<FeishuSheetsService["getCellRange"]>) =>
      (await createSheetsService()).getCellRange(...args),
    resizeRanges: async (...args: Parameters<FeishuSheetsService["resizeRanges"]>) =>
      (await createSheetsService()).resizeRanges(...args),
    freezeRows: async (...args: Parameters<FeishuSheetsService["freezeRows"]>) =>
      (await createSheetsService()).freezeRows(...args),
    hideColumns: async (...args: Parameters<FeishuSheetsService["hideColumns"]>) =>
      (await createSheetsService()).hideColumns(...args),
    getSheetStructure: async (...args: Parameters<FeishuSheetsService["getSheetStructure"]>) =>
      (await createSheetsService()).getSheetStructure(...args),
  };
  const dailySheetManager = new DailySheetManager(database.db, sheetsApi);
  const spreadsheetSetup = new SpreadsheetSetup(
    database.db,
    createSheetsService,
    dailySheetManager,
  );
  return {
    config,
    database,
    tokenProvider,
    createSheetsService,
    dailySheetManager,
    spreadsheetSetup,
    destinationManager: new DestinationManager(database.db, spreadsheetSetup),
    sheetFinalizer: new SheetBatchFinalizer(database.db, createSheetsService, dailySheetManager),
  };
}

export function getAppContext() {
  context ??= createContext();
  return context;
}
