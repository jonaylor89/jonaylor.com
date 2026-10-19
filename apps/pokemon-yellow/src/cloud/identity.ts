import { idbGet, idbPut, STORES } from '../data/db';

export interface OfflineIdentity { id: string; email: string; provider?: 'better-auth' }
const IDENTITY_KEY = 'last-account';
export async function rememberIdentity(identity: OfflineIdentity | null): Promise<void> {
  await idbPut(STORES.settings, IDENTITY_KEY, identity ? { ...identity, provider: 'better-auth' } : null);
}
export async function offlineIdentity(): Promise<OfflineIdentity | undefined> {
  const value = await idbGet<OfflineIdentity | null>(STORES.settings, IDENTITY_KEY);
  return value?.provider === 'better-auth' && typeof value.id === 'string' && typeof value.email === 'string' ? value : undefined;
}
export async function deviceName(): Promise<string> {
  const key = 'cloud-device';
  let value = await idbGet<string>(STORES.settings, key);
  if (!value) {
    const platform = /Android/i.test(navigator.userAgent) ? 'Android' : /iPhone|iPad/i.test(navigator.userAgent) ? 'iOS' : 'Browser';
    value = platform + ' ' + crypto.randomUUID().slice(0, 6);
    await idbPut(STORES.settings, key, value);
  }
  return value;
}

/** A page-lifetime Web Lock prevents stale tabs overwriting a shared local journal. */
export async function acquireAccountLock(owner: string): Promise<void> {
  if (!navigator.locks) throw new Error('This browser cannot safely coordinate game tabs. Please use a current browser.');
  return new Promise<void>((resolve, reject) => {
    void navigator.locks.request('pokeyellow:account:' + owner, { ifAvailable: true }, async lock => {
      if (!lock) { reject(new Error('This account is already playing in another tab. Close that tab, then reload this one.')); return; }
      resolve();
      await new Promise<void>(release => window.addEventListener('pagehide', () => release(), { once: true }));
    }).catch(reject);
  });
}
