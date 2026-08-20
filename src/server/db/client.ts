import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getConfig } from "../config";
import * as schema from "./schema";

let queryClient: ReturnType<typeof postgres> | undefined;

export function getDatabase() {
  queryClient ??= postgres(getConfig().DATABASE_URL, {
    max: 10,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => undefined,
  });
  return drizzle(queryClient, { schema });
}

export async function closeDatabase(): Promise<void> {
  if (queryClient) {
    await queryClient.end({ timeout: 5 });
    queryClient = undefined;
  }
}
