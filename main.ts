// Process entry point. Two modes:
//
//  - Trial mode (MAKEFUN_ENV_URL set): bind an ephemeral port, register it with
//    the environment, poll /done until the trial ends, then exit 0. The port
//    registration is the harness contract; nothing here invents protocol.
//  - Development mode (MAKEFUN_ENV_URL unset): serve on PORT (default 3000)
//    until killed, so the kit's local runner can point at a live server.
//
// Timestamps the API returns come from MAKEFUN_TRIAL_NOW when the trial sets it,
// keeping every scored response deterministic.

import { createApp } from './app.ts';
import type { Server } from 'node:net';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const TRIAL_NOW = process.env.MAKEFUN_TRIAL_NOW;

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

async function registerPort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let fatal: Error | null = null;
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        fatal = new Error(`register rejected with HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register rejected')) fatal = err;
    }
    if (fatal) throw fatal;
    await delay(backoff(attempt));
  }
}

async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Env not answering yet: keep polling.
    }
    await delay(backoff(attempt));
  }
}

/** Bind the server, then keep a permanent error listener: past bind time a server
 * fault is logged, never fatal — the trial harness polls /done and decides the
 * run's fate, not a stray accept error. */
async function listenAndGuard(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(port, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  server.on('error', (err: Error) => {
    process.stderr.write(`[forge] server error: ${err.message}\n`);
  });
}

async function trialMode(): Promise<void> {
  const { server } = createApp({ nowIso: TRIAL_NOW });
  await listenAndGuard(server, 0);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[forge] listening on ${address.port}\n`);
  await registerPort(address.port);
  process.stdout.write('[forge] registered; waiting for done\n');
  await waitUntilDone();
  server.close();
  process.stdout.write('[forge] done\n');
}

async function devMode(): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000;
  const { server } = createApp({ nowIso: TRIAL_NOW });
  await listenAndGuard(server, port);
  process.stdout.write(`[forge] dev server on http://127.0.0.1:${port}\n`);
}

try {
  if (ENV_URL === '') {
    await devMode();
  } else {
    await trialMode();
    process.exit(0);
  }
} catch (err) {
  process.stderr.write(`[forge] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
