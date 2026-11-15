// HTTP front door: a raw net.Server speaking HTTP/1.0 and HTTP/1.1 directly,
// routing health, REST v3, GraphQL v4, MCP and the smart-HTTP git endpoints onto
// the shared in-memory store. Every reply carries an X-GitHub-Request-Id and a
// JSON body, except the git byte streams. Handlers are all synchronous once the
// body is framed, so one pass over the socket buffer answers each request with a
// single write; keep-alive and pipelining fall out of the parse loop.
//
// The wire contract mirrors node:http where a client could tell: header names are
// matched case-insensitively, duplicate headers join with ", ", Content-Length and
// chunked bodies are both framed, Expect: 100-continue is answered, HEAD replies
// carry the would-be Content-Length with no body bytes, and Connection tokens
// decide keep-alive per the request's HTTP version.

import net from 'node:net';
import { advertisementReceivePack, advertisementUploadPack, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { HttpError, handleRest } from './rest.ts';
import { deriveIdentity } from './scenario.ts';
import { Forge } from './store.ts';

export interface AppOptions {
  nowIso?: string;
}

const EMPTY = Buffer.alloc(0);

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

export function createApp(options: AppOptions = {}): { server: net.Server; forge: Forge } {
  const forge = new Forge(deriveIdentity(), options.nowIso ?? '2025-01-01T00:00:00.000Z');
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    new Connection(forge, socket);
  });
  return { server, forge };
}

// ---------------------------------------------------------------------------------------------
// request parsing
// ---------------------------------------------------------------------------------------------

interface PendingHead {
  method: string;
  target: string;
  version: string;
  headers: Record<string, string>;
  chunked: boolean;
  contentLength: number;
  keepAlive: boolean;
}

function parseHead(block: Buffer): PendingHead {
  const lines = block.toString('latin1').split('\r\n');
  const parts = lines[0]!.split(' ');
  const methodRaw = parts[0]!;
  const target = parts[1]!;
  const versionRaw = parts[2]!;
  if (!methodRaw || !target || !versionRaw) throw new Error('bad request line');
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }
  const version = versionRaw.startsWith('HTTP/') ? versionRaw.slice(5) : '1.1';
  const connection = (headers.connection ?? '').toLowerCase();
  const keepAlive = connection.includes('close') ? false : version === '1.0' ? connection.includes('keep-alive') : true;
  const chunked = (headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked');
  const contentLength = chunked ? 0 : Number.parseInt(headers['content-length'] ?? '0', 10) || 0;
  return { method: methodRaw.toUpperCase(), target, version, headers, chunked, contentLength, keepAlive };
}

/** Parse a chunked body starting at `start`; null when more bytes are needed. */
function tryParseChunked(buf: Buffer, start: number): { body: Buffer; consumed: number } | null {
  let pos = start;
  const chunks: Buffer[] = [];
  for (;;) {
    const eol = buf.indexOf('\r\n', pos);
    if (eol < 0) return null;
    const line = buf.toString('latin1', pos, eol);
    const semi = line.indexOf(';');
    const size = Number.parseInt((semi >= 0 ? line.slice(0, semi) : line).trim(), 16);
    if (!Number.isFinite(size) || size < 0) throw new Error('bad chunk size');
    pos = eol + 2;
    if (size === 0) {
      // Trailers, if any, run to the first empty line.
      for (;;) {
        const trailerEnd = buf.indexOf('\r\n', pos);
        if (trailerEnd < 0) return null;
        if (trailerEnd === pos) return { body: Buffer.concat(chunks), consumed: pos + 2 - start };
        pos = trailerEnd + 2;
      }
    }
    if (buf.length < pos + size + 2) return null;
    if (buf[pos + size] !== 13 || buf[pos + size + 1] !== 10) throw new Error('bad chunk terminator');
    chunks.push(buf.subarray(pos, pos + size));
    pos += size + 2;
  }
}

// ---------------------------------------------------------------------------------------------
// one connection: parse loop + synchronous dispatch
// ---------------------------------------------------------------------------------------------

class Connection {
  private buf: Buffer = EMPTY;
  private pending: PendingHead | null = null;
  private closed = false;
  private readonly forge: Forge;
  private readonly socket: net.Socket;

  constructor(forge: Forge, socket: net.Socket) {
    this.forge = forge;
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => {
      this.closed = true;
      socket.destroy();
    });
    socket.on('close', () => {
      this.closed = true;
    });
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    try {
      this.drain();
    } catch {
      // A malformed request stream ends the connection, never the process.
      this.socket.destroy();
    }
  }

  private drain(): void {
    for (;;) {
      if (this.pending === null) {
        const headEnd = this.buf.indexOf('\r\n\r\n');
        if (headEnd < 0) {
          if (this.buf.length > 65536) throw new Error('headers too large');
          return;
        }
        const head = parseHead(this.buf.subarray(0, headEnd));
        this.buf = this.buf.subarray(headEnd + 4);
        if ((head.headers.expect ?? '').toLowerCase().includes('100-continue')) {
          this.socket.write('HTTP/1.1 100 Continue\r\n\r\n');
        }
        this.pending = head;
      }
      const head = this.pending;
      let body: Buffer;
      let consumed: number;
      if (head.chunked) {
        const parsed = tryParseChunked(this.buf, 0);
        if (!parsed) return;
        body = parsed.body;
        consumed = parsed.consumed;
      } else if (head.contentLength > 0) {
        if (this.buf.length < head.contentLength) return;
        body = this.buf.subarray(0, head.contentLength);
        consumed = head.contentLength;
      } else {
        body = EMPTY;
        consumed = 0;
      }
      this.buf = this.buf.subarray(consumed);
      this.pending = null;
      const close = this.dispatch(head, body);
      if (close || this.closed) {
        this.buf = EMPTY;
        this.socket.end();
        return;
      }
    }
  }

  /** Answer one request with a single write; returns true when the socket must close. */
  private dispatch(head: PendingHead, rawBody: Buffer): boolean {
    const response = route(this.forge, head, rawBody);
    const lines = [`HTTP/${head.version} ${response.status} ${STATUS_TEXT[response.status] ?? 'Status'}`];
    lines.push(`content-type: ${response.contentType}`);
    lines.push(`x-github-request-id: ${response.requestId}`);
    lines.push(`content-length: ${response.body.length}`);
    for (const [name, value] of Object.entries(response.extra)) lines.push(`${name}: ${value}`);
    const close = !head.keepAlive;
    if (close) lines.push('connection: close');
    const headerBlock = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
    const out = head.method === 'HEAD' ? headerBlock : Buffer.concat([headerBlock, response.body]);
    this.socket.write(out);
    return close;
  }
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

interface Response {
  status: number;
  contentType: string;
  body: Buffer;
  extra: Record<string, string>;
  requestId: string;
}

function jsonResponse(status: number, payload: unknown, requestId: string, extra: Record<string, string> = {}): Response {
  const body = payload === null || payload === undefined ? EMPTY : Buffer.from(JSON.stringify(payload), 'utf8');
  return { status, contentType: 'application/json', body, extra, requestId };
}

function bytesResponse(status: number, body: Buffer, contentType: string, requestId: string): Response {
  return { status, contentType, body, extra: {}, requestId };
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

function splitTarget(target: string): { path: string; queryString: string } {
  if (target.startsWith('http://') || target.startsWith('https://')) {
    const url = new URL(target);
    return { path: url.pathname, queryString: url.search.startsWith('?') ? url.search.slice(1) : url.search };
  }
  const hash = target.indexOf('#');
  const clean = hash >= 0 ? target.slice(0, hash) : target;
  const q = clean.indexOf('?');
  if (q < 0) return { path: clean, queryString: '' };
  return { path: clean.slice(0, q), queryString: clean.slice(q + 1) };
}

function route(forge: Forge, head: PendingHead, rawBody: Buffer): Response {
  const requestId = forge.nextRequestId();
  try {
    const { path, queryString } = splitTarget(head.target);
    const method = head.method;

    // Health is the only unauthenticated route.
    if (path === '/healthz') {
      return jsonResponse(200, { ok: true }, requestId);
    }

    const authorization = head.headers.authorization ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
    if (token === '') {
      return jsonResponse(401, { message: 'Requires authentication' }, requestId);
    }

    // REST v3.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      const suffix = path.slice('/api/v3'.length);
      const segments = suffix.split('/').filter((s) => s !== '');
      // Fast path: a repeated single-issue read serves memoized bytes directly.
      if (method === 'GET' && queryString === '' && segments.length === 5 && segments[0] === 'repos' && segments[3] === 'issues') {
        const number = Number(segments[4]);
        if (Number.isInteger(number) && number > 0) {
          const cached = forge.getRepo(segments[1]!, segments[2]!)?.issues.get(number)?.cachedBytes;
          if (cached) return bytesResponse(200, cached, 'application/json', requestId);
        }
      }
      const raw = method === 'GET' || method === 'HEAD' ? EMPTY : rawBody;
      const body = parseJsonBody(raw);
      const result = handleRest({
        forge,
        method,
        segments,
        query: new URLSearchParams(queryString),
        body,
        host: head.headers.host ?? 'localhost',
      });
      if (result.rawBytes !== undefined) return bytesResponse(result.status, result.rawBytes, 'application/json', requestId);
      if (result.raw !== undefined) {
        return { status: result.status, contentType: 'application/json', body: Buffer.from(result.raw, 'utf8'), extra: result.headers ?? {}, requestId };
      }
      return jsonResponse(result.status, result.body, requestId, result.headers ?? {});
    }

    // GraphQL v4.
    if (path === '/api/graphql') {
      if (method !== 'POST') return jsonResponse(404, { message: 'Not Found' }, requestId);
      const body = parseJsonBody(rawBody);
      const result = handleGraphql(forge, body);
      return jsonResponse(result.status, result.body, requestId);
    }

    // MCP.
    if (path === '/mcp') {
      if (method !== 'POST') return jsonResponse(404, { message: 'Not Found' }, requestId);
      const result = handleMcp(forge, rawBody.toString('utf8'));
      return jsonResponse(result.status, result.body, requestId);
    }

    // Smart HTTP git: /<owner>/<repo>.git/<service>.
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1]!);
      const repoName = decodeURIComponent(gitMatch[2]!);
      const service = gitMatch[3]!;
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return jsonResponse(404, { message: 'Not Found' }, requestId);
      if (service === 'info/refs') {
        if (method !== 'GET') return jsonResponse(404, { message: 'Not Found' }, requestId);
        const requested = new URLSearchParams(queryString).get('service') ?? '';
        if (requested === 'git-upload-pack') {
          const version2 = head.headers['git-protocol'] === 'version=2';
          return bytesResponse(200, advertisementUploadPack(repo, version2), 'application/x-git-upload-pack-advertisement', requestId);
        }
        if (requested === 'git-receive-pack') {
          return bytesResponse(200, advertisementReceivePack(repo), 'application/x-git-receive-pack-advertisement', requestId);
        }
        return jsonResponse(400, { message: 'Unknown service' }, requestId);
      }
      if (method !== 'POST') return jsonResponse(404, { message: 'Not Found' }, requestId);
      try {
        if (service === 'git-upload-pack') {
          return bytesResponse(200, handleUploadPack(repo, rawBody), 'application/x-git-upload-pack-result', requestId);
        }
        return bytesResponse(200, handleReceivePack(forge, repo, rawBody), 'application/x-git-receive-pack-result', requestId);
      } catch (error) {
        // A malformed git request is a client error, never a crash.
        return jsonResponse(400, { message: error instanceof Error ? error.message : 'Bad git request' }, requestId);
      }
    }

    return jsonResponse(404, { message: 'Not Found' }, requestId);
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { message: error.message }, requestId);
    }
    // Last-resort guard: a handler must never take the process down.
    return jsonResponse(500, { message: error instanceof Error ? error.message : 'Internal Server Error' }, requestId);
  }
}
