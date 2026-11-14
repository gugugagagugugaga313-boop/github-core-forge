// HTTP front door: one node:http server routing health, REST v3, GraphQL v4, MCP
// and the smart-HTTP git endpoints onto the shared in-memory store. Every reply
// carries an X-GitHub-Request-Id and a JSON body, except the git byte streams.

import http from 'node:http';
import { advertisementReceivePack, advertisementUploadPack, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { HttpError, handleRest } from './rest.ts';
import { deriveIdentity } from './scenario.ts';
import { Forge } from './store.ts';

export interface AppOptions {
  nowIso?: string;
}

export function createApp(options: AppOptions = {}): { server: http.Server; forge: Forge } {
  const forge = new Forge(deriveIdentity(), options.nowIso ?? '2025-01-01T00:00:00.000Z');
  const server = http.createServer((req, res) => {
    void handleRequest(forge, req, res).catch((error: unknown) => {
      // Last-resort guard: a handler must never take the process down.
      if (!res.headersSent) {
        const requestId = forge.nextRequestId();
        res.writeHead(500, { 'content-type': 'application/json', 'x-github-request-id': requestId });
        res.end(JSON.stringify({ message: error instanceof Error ? error.message : 'Internal Server Error' }));
      } else {
        res.end();
      }
    });
  });
  return { server, forge };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, requestId: string, extra: Record<string, string> = {}): void {
  const payload = body === null || body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': requestId,
    'content-length': Buffer.byteLength(payload),
    ...extra,
  });
  res.end(payload);
}

function sendBytes(res: http.ServerResponse, status: number, body: Buffer, contentType: string, requestId: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': requestId,
    'content-length': body.length,
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return undefined;
  const text = raw.toString('utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
}

async function handleRequest(forge: Forge, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const requestId = forge.nextRequestId();
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const method = (req.method ?? 'GET').toUpperCase();
  const path = url.pathname;

  // Health is the only unauthenticated route.
  if (path === '/healthz') {
    sendJson(res, 200, { ok: true }, requestId);
    return;
  }

  const authorization = req.headers.authorization ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
  if (token === '') {
    sendJson(res, 401, { message: 'Requires authentication' }, requestId);
    return;
  }

  try {
    // REST v3.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      const suffix = path.slice('/api/v3'.length);
      const segments = suffix.split('/').filter((s) => s !== '');
      const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
      const body = parseJsonBody(raw);
      const result = handleRest({ forge, method, segments, query: url.searchParams, body, host: req.headers.host ?? 'localhost' });
      if (result.raw !== undefined) {
        res.writeHead(result.status, {
          'content-type': 'application/json',
          'x-github-request-id': requestId,
          'content-length': Buffer.byteLength(result.raw),
          ...(result.headers ?? {}),
        });
        res.end(result.raw);
        return;
      }
      sendJson(res, result.status, result.body, requestId, result.headers ?? {});
      return;
    }

    // GraphQL v4.
    if (path === '/api/graphql') {
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' }, requestId);
        return;
      }
      const raw = await readBody(req);
      const body = parseJsonBody(raw);
      const result = handleGraphql(forge, body);
      sendJson(res, result.status, result.body, requestId);
      return;
    }

    // MCP.
    if (path === '/mcp') {
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' }, requestId);
        return;
      }
      const raw = await readBody(req);
      const result = handleMcp(forge, raw.toString('utf8'));
      sendJson(res, result.status, result.body, requestId);
      return;
    }

    // Smart HTTP git: /<owner>/<repo>.git/<service>.
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1]!);
      const repoName = decodeURIComponent(gitMatch[2]!);
      const service = gitMatch[3]!;
      const repo = forge.getRepo(owner, repoName);
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' }, requestId);
        return;
      }
      if (service === 'info/refs') {
        if (method !== 'GET') {
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }
        const requested = url.searchParams.get('service') ?? '';
        if (requested === 'git-upload-pack') {
          const version2 = req.headers['git-protocol'] === 'version=2';
          sendBytes(res, 200, advertisementUploadPack(repo, version2), 'application/x-git-upload-pack-advertisement', requestId);
          return;
        }
        if (requested === 'git-receive-pack') {
          sendBytes(res, 200, advertisementReceivePack(repo), 'application/x-git-receive-pack-advertisement', requestId);
          return;
        }
        sendJson(res, 400, { message: 'Unknown service' }, requestId);
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' }, requestId);
        return;
      }
      const raw = await readBody(req);
      try {
        if (service === 'git-upload-pack') {
          sendBytes(res, 200, handleUploadPack(repo, raw), 'application/x-git-upload-pack-result', requestId);
        } else {
          sendBytes(res, 200, handleReceivePack(forge, repo, raw), 'application/x-git-receive-pack-result', requestId);
        }
      } catch (error) {
        // A malformed git request is a client error, never a crash.
        sendJson(res, 400, { message: error instanceof Error ? error.message : 'Bad git request' }, requestId);
      }
      return;
    }

    sendJson(res, 404, { message: 'Not Found' }, requestId);
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { message: error.message }, requestId);
      return;
    }
    throw error;
  }
}
