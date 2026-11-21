import { ApiError } from './http.js';
import { signedStorageVideoUrl, storageConfigured } from './media.js';
import { signDeliveryToken } from './delivery-token.js';

function deliveryPrefix(): URL {
  const prefix = new URL(process.env.TIKTOK_MEDIA_URL_PREFIX || '');
  const site = new URL(process.env.URL || '');
  if (prefix.protocol !== 'https:' || prefix.origin !== site.origin || prefix.pathname !== '/tiktok-media/' ||
      prefix.search || prefix.hash || prefix.username || prefix.password) {
    throw new ApiError(503, 'Configure the verified site URL with the /tiktok-media/ prefix before publishing.');
  }
  return prefix;
}

export function deliveryConfigured(): boolean {
  if (process.env.TIKTOK_PUBLISHING_ENABLED !== '1' || !storageConfigured() || Buffer.byteLength(process.env.SESSION_SECRET || '') < 32) return false;
  try { deliveryPrefix(); return true; } catch { return false; }
}

export async function createDeliveryUrl(storageKey: string): Promise<string> {
  if (!deliveryConfigured()) throw new ApiError(503, 'Publishing is on hold until TikTok video delivery is enabled.');
  const destination = new URL('video.mp4', deliveryPrefix());
  const storageUrl = await signedStorageVideoUrl(storageKey);
  destination.searchParams.set('token', await signDeliveryToken(storageUrl, process.env.SESSION_SECRET!));
  return destination.toString();
}
