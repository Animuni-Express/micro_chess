import { getDatabase } from '@netlify/database';
export default async () => {
  await getDatabase().sql`SELECT mc_control('cleanup','{}'::jsonb)`;
  return new Response(null, { status: 204 });
};
export const config = { schedule: '*/10 * * * *' };
