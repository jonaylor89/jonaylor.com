import { AccountSaves } from '../cloud/saves';
import { GuestSaves } from '../cloud/guest';
import { rememberIdentity } from '../cloud/identity';
import type { PlayerAuth, PlayerIdentity } from '../cloud/client';
import { choose, describeCheckpoint, signIn } from './accountDialogs';

export async function resolveSaveConflicts(root: HTMLElement, saves: AccountSaves): Promise<void> {
  while (saves.journal.conflict) {
    const cloud = saves.journal.conflict;
    const choice = await choose(root, 'Two adventures. Your choice.',
      'These are saved checkpoints, not a merge. Choosing restarts from that checkpoint; unsaved play is not included. The alternative is kept in recovery history.',
      [
        { value: 'local', label: 'Keep this device’s save', detail: describeCheckpoint(saves.journal.payload) },
        { value: 'cloud', label: 'Use the cloud save', detail: describeCheckpoint(cloud.payload) + '\n' + cloud.device + ' · revision ' + cloud.revision },
      ]);
    await saves.resolve(choice);
  }
}
interface PanelHost { pause(paused: boolean): void; restart(): void }

export function mountAccountPanel(root: HTMLElement, saves: AccountSaves | GuestSaves, client: PlayerAuth, identity: PlayerIdentity | undefined, host: PanelHost) {
  const account = saves instanceof AccountSaves ? saves : undefined;
  const guest = saves instanceof GuestSaves ? saves : undefined;
  const opener = document.createElement('button'); opener.className = 'account-open'; opener.setAttribute('aria-haspopup', 'dialog');
  const dialog = document.createElement('dialog'); dialog.className = 'trainer-dialog'; dialog.setAttribute('aria-labelledby', 'trainer-account-title');
  dialog.innerHTML = `<p class="trainer-eyebrow">TRAINER ACCOUNT / CLOUD CHECKPOINTS</p><h1 id="trainer-account-title">Take it with you.</h1>
    <p class="trainer-identity"></p><p role="status" class="trainer-sync"></p>
    <p class="trainer-note">START → SAVE always keeps a checkpoint on this device. Sign in only when you want cloud backup and other devices.</p>
    <div class="trainer-choices"><button type="button" data-action="signin">Sign in / create account</button><button type="button" data-action="sync">Sync now</button><button type="button" data-action="recover">Recovery history</button><button type="button" data-action="export">Download saved checkpoint</button><button type="button" data-action="signout">Sign out</button><button type="button" data-action="close">Back to game</button></div><p class="trainer-offline-status"></p>`;
  const suggestion = document.createElement('aside'); suggestion.className = 'guest-save-suggestion'; suggestion.hidden = true; suggestion.setAttribute('aria-label', 'Optional cloud backup');
  suggestion.innerHTML = '<p><strong>Saved on this device.</strong><br>Sign in to back up your adventure and continue on another device.</p><button type="button" data-action="backup">Sign in</button><button type="button" data-action="dismiss">Not now</button>';
  root.append(opener, dialog, suggestion);
  const q = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  q('.trainer-identity').textContent = identity ? identity.email + ' · ' + account?.device : 'Guest adventure · no account required';
  for (const action of ['sync', 'recover', 'signout']) q('[data-action=' + action + ']').hidden = !account;
  if (account) q('[data-action=signin]').textContent = 'Sign in again / switch account';
  let handling = false; let offered = false;
  function render() {
    const label = account
      ? ({ local: 'Saved on this device', pending: 'Sync pending', syncing: 'Syncing…', synced: 'Synced', conflict: 'Choose a save', error: 'Sync unavailable' }[account.status])
      : guest?.payload ? 'Guest · saved on this device' : 'Guest · play without signing in';
    opener.textContent = saves.localSaveFailed ? 'ACCOUNT · Save failed' : 'ACCOUNT · ' + label;
    q('.trainer-sync').textContent = saves.localSaveFailed ? 'Save was NOT written. Browser storage is unavailable or full.' : label + (account?.error ? '. ' + account.error : '');
    if (account?.journal.conflict && !handling) void conflict();
    if (guest?.lastEvent === 'saved' && !guest.localSaveFailed && !offered) { offered = true; suggestion.hidden = false; }
  }
  async function conflict() {
    if (!account) return;
    handling = true; host.pause(true); if (dialog.open) dialog.close();
    try { await resolveSaveConflicts(root, account); host.restart(); }
    catch (error) { alert((error as Error).message); }
    finally { handling = false; if (!account.journal.conflict) host.pause(false); }
  }
  function open() { render(); if (handling || account?.journal.conflict) return; host.pause(true); if (!dialog.open) dialog.showModal(); }
  async function login(token?: string) {
    if (handling) return;
    handling = true; host.pause(true); suggestion.hidden = true;
    if (dialog.open) dialog.close();
    try {
      const result = await signIn(root, client, token);
      if (result) {
        const url = new URL(location.href); url.searchParams.delete('account'); url.searchParams.delete('token');
        url.searchParams.delete('new');
        location.assign(url.pathname + url.search);
      }
    } finally { handling = false; host.pause(false); focusGame(); }
  }
  opener.onclick = open;
  q<HTMLButtonElement>('[data-action=close]').onclick = () => dialog.close();
  const focusGame = () => root.querySelector<HTMLCanvasElement>('canvas')?.focus({ preventScroll: true });
  dialog.addEventListener('close', () => { if (!handling) { host.pause(false); focusGame(); } });
  q<HTMLButtonElement>('[data-action=signin]').onclick = () => {
    if (confirm('Sign in or switch account? The game restarts after sign-in. Use START → SAVE first; unsaved play is not included.')) void login();
  };
  suggestion.querySelector<HTMLButtonElement>('[data-action=backup]')!.onclick = () => { void login(); };
  suggestion.querySelector<HTMLButtonElement>('[data-action=dismiss]')!.onclick = () => { suggestion.hidden = true; focusGame(); };
  q<HTMLButtonElement>('[data-action=sync]').onclick = () => { void account?.sync(); };
  q<HTMLButtonElement>('[data-action=export]').onclick = () => {
    const payload = account ? account.journal.payload : guest?.payload;
    if (!payload) return;
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'pokeyellow-save.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  q<HTMLButtonElement>('[data-action=recover]').onclick = async () => {
    if (!account || handling) return; handling = true;
    try {
      const local = [...account.journal.backups].reverse().map((b, i) => ({ value: 'local-' + i, payload: b.payload, label: 'Device backup · ' + new Date(b.savedAt).toLocaleString(), detail: b.reason + '\n' + describeCheckpoint(b.payload) }));
      let cloud: { value: string; payload: string | null; label: string; detail: string }[] = [];
      try { cloud = (await account.history()).map(b => ({ value: 'cloud-' + b.revision, payload: b.payload, label: 'Cloud revision ' + b.revision + ' · ' + b.device, detail: describeCheckpoint(b.payload) })); } catch { /* Offline local recovery still works. */ }
      const backups = [...local, ...cloud]; dialog.close();
      const selected = await choose(root, 'Recovery history', 'Restoring replaces the checkpoint and restarts the game. Unsaved play is not included.',
        [{ value: 'cancel', label: 'Back without restoring' }, ...backups]);
      const entry = backups.find(b => b.value === selected);
      if (entry && confirm('Restore this checkpoint and restart? Unsaved play will be lost.')) {
        await account.stage(entry.payload); await account.sync(); await resolveSaveConflicts(root, account); host.restart();
      } else dialog.showModal();
    } catch (error) { alert((error as Error).message); if (!dialog.open) dialog.showModal(); }
    finally { handling = false; }
  };
  q<HTMLButtonElement>('[data-action=signout]').onclick = async () => {
    if (!confirm('Sign out and return to guest play? Use START → SAVE first. Account checkpoints and pending uploads remain separate from guest progress.')) return;
    try {
      const result = await client.signOut();
      if (result.error) throw new Error(result.error.message);
      await rememberIdentity(null); host.restart();
    } catch (error) { q('.trainer-sync').textContent = 'Sign-out could not be confirmed. Reconnect and try again. ' + (error as Error).message; }
  };
  const unsubscribe = saves.subscribe(render);
  const sync = () => { if (navigator.onLine && !document.hidden) void account?.sync(); };
  window.addEventListener('online', sync); document.addEventListener('visibilitychange', sync);
  const timer = setInterval(sync, 30_000);
  render();
  const params = new URLSearchParams(location.search);
  if (params.get('account') === 'recovery') {
    if (params.get('token')) void login(params.get('token')!);
    else { open(); q('.trainer-sync').textContent = 'That password-reset link is invalid or expired. Open Sign in and request a new one.'; }
  }
  return {
    offlineReady(ready: boolean) { q('.trainer-offline-status').textContent = ready ? 'Offline ready on this device. Clearing browser data can remove guest progress and unsynced saves.' : 'Offline app-shell caching is unavailable; keep this tab open for offline play.'; },
    dispose() { clearInterval(timer); unsubscribe(); window.removeEventListener('online', sync); document.removeEventListener('visibilitychange', sync); dialog.remove(); opener.remove(); suggestion.remove(); },
  };
}
