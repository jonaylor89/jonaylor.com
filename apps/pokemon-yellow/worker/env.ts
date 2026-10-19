import type { D1Database, ExecutionContext } from '@cloudflare/workers-types';

export interface Env {
  DB: D1Database;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  APP_ORIGIN: string;
  BETTER_AUTH_SECRET: string;
  LOCAL_DEV?: string;
  EMAIL_FROM?: string;
  POSTMARK_SERVER_TOKEN?: string;
  POSTMARK_MESSAGE_STREAM?: string;
}
export type Context = Pick<ExecutionContext, 'waitUntil'>;
export const isLoopback = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
export function isLocal(request: Request, env: Env): boolean {
  return env.LOCAL_DEV === 'true' && isLoopback(new URL(request.url).hostname) && isLoopback(new URL(env.APP_ORIGIN).hostname);
}
