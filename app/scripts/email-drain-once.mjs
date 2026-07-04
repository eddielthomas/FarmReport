// =============================================================================
// email-drain-once.mjs — one-shot CLI to invoke the outbox drain.
// -----------------------------------------------------------------------------
// Useful for tests + ops; identical effect to a single scheduler tick.
// Reports counter totals to stdout.
//
// Env passthrough:
//   PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE — DB target
//   EMAIL_RESEND_DISABLED=1                    — mock transport
//   RESEND_API_KEY                             — real transport (production)
// =============================================================================

import { drainOnce, reclaimStuck } from '../api/v1/email/drain.mjs';
import { pool } from '../api/v1/db/pool.mjs';

try {
  const reclaimed = await reclaimStuck();
  const counters  = await drainOnce();
  console.log(`drain-once  reclaimed=${reclaimed}  ${JSON.stringify(counters)}`);
} catch (err) {
  console.error('drain-once failed', err?.message ?? err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
