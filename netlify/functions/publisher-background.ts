import { authorizedWorker } from '../lib/worker-auth.js';
import { runPublishingTick } from '../lib/publishing.js';
import { syncAnalytics } from '../lib/analytics.js';

export default async function handler(request: Request): Promise<void> {
  if (request.method !== 'POST' || !authorizedWorker(request) || process.env.CONTEXT !== 'production') return;
  try {
    const result = await runPublishingTick({ budgetMs: 80_000, maxSubmissions: 3, maxStatusChecks: 5 });
    console.log('Publishing worker completed:', JSON.stringify(result));
  } catch {
    console.error('Publishing worker failed; posts retain their recorded state.');
  }
  try {
    await syncAnalytics();
  } catch {
    console.error('Analytics sync failed; the next eligible worker run will retry.');
  }
}
