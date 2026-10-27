import { getDatabase } from '@netlify/database';
export default async () => {
  await getDatabase().sql`SELECT mc_control('cleanup','{}'::jsonb)`;
  return new Response(null, { status: 204 });
};
// Inactive database compute is billed: avoid frequent wake-ups during idle periods.
export const config = { schedule: '0 0 * * 0' };
