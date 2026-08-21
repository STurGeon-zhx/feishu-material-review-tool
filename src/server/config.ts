import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().default("file:./data/poc.db"),
  CREDENTIAL_KEY_PATH: z.string().default("./data/credentials.key"),
});

export function parseConfig(environment: Record<string, string | undefined>) {
  const value = schema.parse(environment);
  return {
    databaseUrl: value.DATABASE_URL,
    credentialKeyPath: value.CREDENTIAL_KEY_PATH,
  };
}

export function readConfig() {
  return parseConfig(process.env);
}
