import { getDatabase } from "./db/client";
import { recoverInterruptedAssets } from "./db/repository";
import { readConfig } from "./config";
import { FeishuAuth } from "./feishu/auth";
import { FeishuHttpClient } from "./feishu/http-client";
import { FeishuService } from "./feishu/service";
import { ProjectSetup } from "./projects/project-setup";
import { BatchFinalizer } from "./uploads/finalize-batch";

let context: ReturnType<typeof createContext> | undefined;

function createContext() {
  const config = readConfig();
  const database = getDatabase();
  recoverInterruptedAssets(database.db);
  const auth = new FeishuAuth(database.db, config);
  const createService = async (localUserId: string) =>
    new FeishuService(new FeishuHttpClient(await auth.getValidAccessToken(localUserId)));
  return {
    config,
    database,
    auth,
    createService,
    projectSetup: new ProjectSetup(database.db, createService),
    finalizer: new BatchFinalizer(database.db, createService),
  };
}

export function getAppContext() {
  context ??= createContext();
  return context;
}
