import { createPlayerAuth, WorkerSaves, type PlayerIdentity } from './client';
import { acquireAccountLock, deviceName, offlineIdentity, rememberIdentity } from './identity';
import { AccountSaves } from './saves';
import { GuestSaves } from './guest';
import { checksum, setSaveBackend } from '../game/save';
import { choose, describeCheckpoint } from '../ui/accountDialogs';
import { resolveSaveConflicts } from '../ui/accountPanel';
import { idbGet, idbPut, STORES } from '../data/db';

export async function bootstrapPlayer(root: HTMLElement) {
  const client = createPlayerAuth();
  let identity: PlayerIdentity | undefined;
  if (navigator.onLine) {
    try {
      const result = await client.getSession();
      if (result.error) throw new Error(result.error.message);
      if (result.data?.user.emailVerified) {
        identity = { id: result.data.user.id, email: result.data.user.email };
        await rememberIdentity(identity);
      } else identity = await offlineIdentity(); // An expired session must not hide an account's unsynced checkpoint.
    } catch { identity = await offlineIdentity(); /* Backend outage must not block local play. */ }
  } else identity = await offlineIdentity();
  await acquireAccountLock(identity?.id ?? 'guest');
  let saves: AccountSaves | GuestSaves;
  if (identity) {
    saves = new AccountSaves(identity.id, await deviceName(), new WorkerSaves(identity.id));
    await saves.open();
    if (navigator.onLine) await saves.sync();
    await resolveSaveConflicts(root, saves);
    const guest = new GuestSaves(); await guest.open();
    if (guest.payload) {
      const key = 'guest-import-decided:' + identity.id;
      const fingerprint = checksum(guest.payload);
      if (await idbGet<string>(STORES.settings, key) !== fingerprint) {
        const answer = await choose(root, 'Bring your guest adventure?',
          'This device has a guest checkpoint. Import it into your account, or keep the account checkpoint. Nothing is merged; the guest copy is retained.',
          [
            { value: 'account', label: 'Keep my account save', detail: describeCheckpoint(saves.journal.payload) },
            { value: 'guest', label: 'Import the guest save', detail: describeCheckpoint(guest.payload) },
          ]);
        if (answer === 'guest') {
          await saves.stage(guest.payload); await saves.sync(); await resolveSaveConflicts(root, saves);
        }
        await idbPut(STORES.settings, key, fingerprint);
      }
    }
  } else { saves = new GuestSaves(); await saves.open(); }
  setSaveBackend(saves);
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  return { saves, client, identity };
}
