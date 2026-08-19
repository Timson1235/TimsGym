// Quick Neon connectivity check — connects the same way the app does.
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
  host: process.env.SQL_HOST,
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  database: process.env.SQL_DB_NAME,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

try {
  const tables = await pool.query(
    "select table_name from information_schema.tables where table_schema='public' order by table_name"
  );
  console.log('Connected to Neon. Tables:', tables.rows.map((r) => r.table_name).join(', '));
  for (const t of ['users', 'workouts', 'exercises', 'profiles']) {
    const c = await pool.query(`select count(*)::int as n from ${t}`);
    console.log(`  ${t}: ${c.rows[0].n} rows`);
  }
} catch (e) {
  console.error('DB CHECK FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
