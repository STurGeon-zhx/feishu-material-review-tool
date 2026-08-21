import { z } from "zod";

const schema = z.object({
  FEISHU_APP_ID: z.string().min(1),
  FEISHU_APP_SECRET: z.string().min(1),
  DATABASE_URL: z.string().default("file:./data/poc.db"),
});

export function parseConfig(environment: Record<string, string | undefined>) {
  const value = schema.parse(environment);
  return {
    appId: value.FEISHU_APP_ID,
    appSecret: value.FEISHU_APP_SECRET,
    databaseUrl: value.DATABASE_URL,
  };
}

export function readConfig() {
  return parseConfig(process.env);
}
