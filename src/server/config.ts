import { z } from "zod";

const schema = z.object({
  FEISHU_APP_ID: z.string().min(1),
  FEISHU_APP_SECRET: z.string().min(1),
  FEISHU_REDIRECT_URI: z.string().url(),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  DATABASE_URL: z.string().default("file:./data/poc.db"),
  DEMO_USER_ID: z.string().default("demo_user"),
});

export function readConfig() {
  const value = schema.parse(process.env);
  const decodedKey = Buffer.from(value.TOKEN_ENCRYPTION_KEY, "base64");
  if (decodedKey.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY 必须是 32 字节 Base64 密钥");
  return {
    appId: value.FEISHU_APP_ID,
    appSecret: value.FEISHU_APP_SECRET,
    redirectUri: value.FEISHU_REDIRECT_URI,
    encryptionKey: value.TOKEN_ENCRYPTION_KEY,
    databaseUrl: value.DATABASE_URL,
    demoUserId: value.DEMO_USER_ID,
  };
}
