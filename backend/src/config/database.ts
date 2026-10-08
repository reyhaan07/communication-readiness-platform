import { Pool } from 'pg';
import { env } from './env';
import { pgConnectionConfig } from './pgConnection';

// Supabase pooler connections (port 6543 = transaction-mode) and remote
// Postgres connections need more time than the default 2 s budget.
export const db = new Pool({
  ...pgConnectionConfig(env.DATABASE_URL),
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

db.on('connect', () => {
  if (env.NODE_ENV === 'development') {
    console.log('[db] pool connected');
  }
});

db.on('error', (err) => {
  console.error('[db] Unexpected background client error on pool:', err);
});

