import type { PlayerAuth, PlayerIdentity } from '../cloud/client';
import { rememberIdentity } from '../cloud/identity';
import { deserializeSave } from '../game/save';
import { CONSTANTS } from '../rom/constants';

export function describeCheckpoint(payload: string | null): string {
  if (payload === null) return 'No saved game (empty or cleared slot)';
  try {
    const file = deserializeSave(payload); const state = file.state;
    const minutes = Math.floor(state.frames / 3600);
    const badges = state.badges.toString(2).replace(/0/g, '').length;
    const place = Object.entries(CONSTANTS.map).find(([, id]) => id === state.player.map)?.[0].replaceAll('_', ' ') ?? 'Map ' + state.player.map;
    return state.player.name + ' · ' + badges + ' badges · ' + Math.floor(minutes / 60) + 'h ' + minutes % 60 +
      'm · ' + place + '\nSaved ' + new Date(file.savedAt).toLocaleString();
  } catch { return 'Unreadable checkpoint'; }
}
export interface Choice<T extends string> { value: T; label: string; detail?: string }
export function choose<T extends string>(root: HTMLElement, title: string, explanation: string, choices: Choice<T>[]): Promise<T> {
  const dialog = document.createElement('dialog'); dialog.className = 'trainer-dialog';
  const heading = document.createElement('h1'); heading.textContent = title; heading.id = 'trainer-dialog-' + crypto.randomUUID();
  dialog.setAttribute('aria-labelledby', heading.id);
  const text = document.createElement('p'); text.textContent = explanation;
  const list = document.createElement('div'); list.className = 'trainer-choices';
  dialog.append(heading, text, list); root.append(dialog);
  return new Promise(resolve => {
    for (const choice of choices) {
      const button = document.createElement('button');
      const label = document.createElement('strong'); label.textContent = choice.label; button.append(label);
      if (choice.detail) { const detail = document.createElement('span'); detail.textContent = choice.detail; button.append(detail); }
      button.onclick = () => { dialog.close(); dialog.remove(); resolve(choice.value); };
      list.append(button);
    }
    dialog.addEventListener('cancel', event => event.preventDefault()); dialog.showModal();
  });
}

/** Optional, cancellable sign-in. No auth screen is ever required to begin or save as a guest. */
export function signIn(root: HTMLElement, client: PlayerAuth, recoveryToken?: string): Promise<PlayerIdentity | undefined> {
  const dialog = document.createElement('dialog'); dialog.className = 'trainer-dialog trainer-card';
  dialog.setAttribute('aria-labelledby', 'trainer-signin-title');
  dialog.innerHTML = `<p class="trainer-eyebrow">POKéMON YELLOW / TRAINER ACCOUNT</p>
    <h1 id="trainer-signin-title">${recoveryToken ? 'A fresh start.' : 'Keep your adventure.'}</h1>
    <p class="trainer-intro">Play and save on this device without an account. Sign in for cloud backup and other devices.</p>
    <form>
      <label class="trainer-email">Email<input name="email" type="email" autocomplete="username" required maxlength="254"></label>
      <label>Password<input name="password" type="password" autocomplete="${recoveryToken ? 'new-password' : 'current-password'}" required maxlength="128" minlength="${recoveryToken ? 12 : 1}"></label>
      <button type="submit">${recoveryToken ? 'Update password' : 'Sign in'}</button>
    </form>
    <div class="trainer-auth-actions"><button type="button" data-action="register">Create account</button><button type="button" data-action="reset">Forgot password?</button><button type="button" data-action="verify">Resend verification</button></div>
    <p role="status" aria-live="polite"></p><button type="button" data-action="cancel">Back to game</button>`;
  root.append(dialog);
  const form = dialog.querySelector<HTMLFormElement>('form')!;
  const email = form.elements.namedItem('email') as HTMLInputElement;
  const password = form.elements.namedItem('password') as HTMLInputElement;
  const status = dialog.querySelector<HTMLElement>('[role=status]')!;
  const submit = dialog.querySelector<HTMLButtonElement>('[type=submit]')!;
  const register = dialog.querySelector<HTMLButtonElement>('[data-action=register]')!;
  const reset = dialog.querySelector<HTMLButtonElement>('[data-action=reset]')!;
  const verify = dialog.querySelector<HTMLButtonElement>('[data-action=verify]')!;
  let mode: 'login' | 'register' | 'recovery' = recoveryToken ? 'recovery' : 'login';
  let busy = false;
  function setBusy(value: boolean) { busy = value; for (const b of dialog.querySelectorAll<HTMLButtonElement>('button')) b.disabled = value; }
  function loginMode() {
    mode = 'login'; submit.textContent = 'Sign in'; register.textContent = 'Create account';
    password.autocomplete = 'current-password'; password.minLength = 1;
    email.required = true; dialog.querySelector<HTMLElement>('.trainer-email')!.hidden = false;
    register.hidden = reset.hidden = verify.hidden = false;
  }
  if (recoveryToken) {
    dialog.querySelector<HTMLElement>('.trainer-email')!.hidden = true; email.required = false;
    register.hidden = reset.hidden = verify.hidden = true;
  }
  register.onclick = () => {
    if (mode === 'register') loginMode();
    else {
      mode = 'register'; submit.textContent = 'Create account'; register.textContent = 'Already registered? Sign in';
      password.autocomplete = 'new-password'; password.minLength = 12;
    }
    status.textContent = mode === 'register' ? 'Use at least 12 characters. Verify your email before cloud saves become available.' : '';
  };
  const callbackURL = location.origin + location.pathname;
  return new Promise(resolve => {
    const finish = (identity?: PlayerIdentity) => { dialog.close(); dialog.remove(); resolve(identity); };
    dialog.querySelector<HTMLButtonElement>('[data-action=cancel]')!.onclick = () => finish();
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!busy) finish(); });
    reset.onclick = async () => {
      if (!email.reportValidity()) return; setBusy(true);
      try {
        const result = await client.requestPasswordReset({ email: email.value.trim(), redirectTo: callbackURL + '?account=recovery' });
        if (result.error) throw new Error(result.error.message);
        status.textContent = 'If that account exists, a password-reset email is on its way.';
      } catch (error) { status.textContent = (error as Error).message; } finally { setBusy(false); }
    };
    verify.onclick = async () => {
      if (!email.reportValidity()) return; setBusy(true);
      try {
        const result = await client.sendVerificationEmail({ email: email.value.trim(), callbackURL });
        if (result.error) throw new Error(result.error.message);
        status.textContent = 'Check your email for a verification link if your account needs one.';
      } catch (error) { status.textContent = (error as Error).message; } finally { setBusy(false); }
    };
    form.onsubmit = async event => {
      event.preventDefault(); setBusy(true); status.textContent = 'Connecting…';
      try {
        if (mode === 'recovery') {
          const result = await client.resetPassword({ newPassword: password.value, token: recoveryToken! });
          if (result.error) throw new Error(result.error.message);
          const url = new URL(location.href); url.searchParams.delete('token'); url.searchParams.delete('account');
          history.replaceState(null, '', url.pathname + url.search);
          loginMode(); status.textContent = 'Password updated. Sign in with your new password.';
        } else if (mode === 'register') {
          const result = await client.signUp.email({ name: email.value.trim().split('@')[0], email: email.value.trim(), password: password.value, callbackURL });
          if (result.error) throw new Error(result.error.message);
          loginMode(); status.textContent = 'Check your email to verify your account, then sign in. Your guest checkpoint stays on this device.';
        } else {
          const result = await client.signIn.email({ email: email.value.trim(), password: password.value });
          if (result.error || !result.data.user) throw new Error(result.error?.message ?? 'Sign-in failed.');
          const identity = { id: result.data.user.id, email: result.data.user.email };
          await rememberIdentity(identity); finish(identity);
        }
      } catch (error) { status.textContent = (error as Error).message; } finally { setBusy(false); }
    };
    dialog.showModal();
  });
}
