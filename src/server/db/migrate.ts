import { migrate } from "drizzle-orm/postgres-js/migrator";

import { closeDatabase, getDatabase } from "./client";

await migrate(getDatabase(), { migrationsFolder: "drizzle" });
await closeDatabase();
