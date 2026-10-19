import { isLocal, type Context, type Env } from './env';

export function queueMail(request: Request, env: Env, ctx: Context, recipient: string, subject: string, url: string): void {
  const delivery = (async () => {
    if (isLocal(request, env)) {
      await env.DB.prepare('INSERT INTO local_mail(recipient, subject, url, created_at) VALUES (?, ?, ?, ?)')
        .bind(recipient, subject, url, Date.now()).run();
      await env.DB.prepare('DELETE FROM local_mail WHERE id NOT IN (SELECT id FROM local_mail ORDER BY id DESC LIMIT 100)').run();
    } else {
      const response = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST', signal: AbortSignal.timeout(10_000),
        headers: { 'X-Postmark-Server-Token': env.POSTMARK_SERVER_TOKEN!, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ From: env.EMAIL_FROM, To: recipient, Subject: subject, TextBody: subject + '\n\n' + url + '\n\nIf you did not request this, ignore this message.', MessageStream: env.POSTMARK_MESSAGE_STREAM ?? 'outbound' }),
      });
      if (!response.ok) throw new Error('Email delivery failed (' + response.status + ')');
      const result = await response.json() as { ErrorCode?: number };
      if (result.ErrorCode !== 0) throw new Error('Email provider rejected the message');
    }
  })();
  // Do not leak account existence through email-delivery timing; keep the Worker alive.
  ctx.waitUntil(delivery.catch(() => { console.error('Authentication email delivery failed'); }));
}
