import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export interface PostgresDatabaseHandle {
  pool: Pool;
  db: NodePgDatabase<typeof schema>;
  close: () => Promise<void>;
}

export function openPostgresDatabase(connectionString: string): PostgresDatabaseHandle {
  const pool = new Pool({ connectionString });
  const db = drizzle({ client: pool, schema });
  return {
    pool,
    db,
    close: async () => {
      await pool.end();
    }
  };
}
