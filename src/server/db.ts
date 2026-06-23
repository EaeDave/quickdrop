import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { loadConfig } from "./config";
import * as schema from "./schema";

export const sql = new SQL(loadConfig().databaseUrl);
export const db = drizzle(sql, { schema });
export type SqlClient = typeof sql;
export type Database = typeof db;
