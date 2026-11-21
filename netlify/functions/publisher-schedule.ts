import type { Config } from '@netlify/functions';
import { workerAuthorization } from '../lib/worker-auth.js';

export default async function handler(): Promise<void> {
  if (process.env.CONTEXT !== 'production') return;
  const site = new URL(process.env.URL || '');
  if (site.protocol !== 'https:') throw new Error('The worker needs the canonical HTTPS site URL.');
  const response = await fetch(new URL('/.netlify/functions/publisher-background', site), {
    method: 'POST',
    headers: { Authorization: workerAuthorization() },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 202) throw new Error(`Publishing worker dispatch failed (${response.status}).`);
}

export const config: Config = { schedule: '* * * * *' };
