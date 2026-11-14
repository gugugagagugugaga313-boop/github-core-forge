// Model Context Protocol endpoint: JSON-RPC 2.0 over POST /mcp. Implements both
// the modern discovery era (server/discover) and the legacy initialize era, and
// exposes six tools over the same store the REST and GraphQL surfaces use.

import type { Forge, Repo } from './store.ts';
import { issueView, pullView, repoView } from './rest.ts';

const SERVER_NAME = 'github-core-forge';
const SERVER_VERSION = '1.0.0';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}

// Frozen constant: tools/list answers byte-for-byte identical on every call.
const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        name: { type: 'string', description: 'Repository name.' },
        owner: { type: 'string', description: 'Owner login; ignored, repositories are created for the authenticated user.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
        body: { type: 'string', description: 'Pull request body.' },
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

class ToolFault extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function textResult(payload: unknown): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const structured = typeof payload === 'string' ? { result: payload } : (payload as Record<string, unknown>);
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true, structuredContent: { error: message } };
}

function needString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') throw new ToolFault(-32602, `Missing required argument: ${key}`);
  return value;
}

function needRepo(forge: Forge, owner: string, repoName: string): Repo {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) throw new ToolFault(-32602, `Repository ${owner}/${repoName} not found`);
  return repo;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = needString(args, 'name');
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = args.private === true;
      const repo = forge.createRepo(forge.viewerLogin, repoName, description, isPrivate);
      if (!repo) return errorResult(`Repository '${repoName}' already exists`);
      return textResult(repoView(forge, repo));
    }
    case 'get_repo': {
      const owner = needString(args, 'owner');
      const repoName = needString(args, 'repo');
      const repo = needRepo(forge, owner, repoName);
      return textResult(repoView(forge, repo));
    }
    case 'create_issue': {
      const owner = needString(args, 'owner');
      const repoName = needString(args, 'repo');
      const title = needString(args, 'title');
      const body = typeof args.body === 'string' ? args.body : '';
      const repo = needRepo(forge, owner, repoName);
      const issue = forge.createIssue(repo, title, body, []);
      return textResult(issueView(forge, repo, issue));
    }
    case 'list_issues': {
      const owner = needString(args, 'owner');
      const repoName = needString(args, 'repo');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const repo = needRepo(forge, owner, repoName);
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number)
        .map((issue) => issueView(forge, repo, issue));
      return { content: [{ type: 'text', text: JSON.stringify(issues) }], structuredContent: { issues } };
    }
    case 'create_pull_request': {
      const owner = needString(args, 'owner');
      const repoName = needString(args, 'repo');
      const title = needString(args, 'title');
      const head = needString(args, 'head');
      const base = needString(args, 'base');
      const body = typeof args.body === 'string' ? args.body : '';
      const repo = needRepo(forge, owner, repoName);
      const headSha = forge.resolveCommit(repo, head);
      const baseSha = forge.resolveCommit(repo, base);
      if (!headSha || !baseSha) return errorResult('head or base branch does not exist');
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          return errorResult('A pull request already exists for this head and base');
        }
      }
      const pull = forge.createPull(repo, title, body, head, base, headSha, baseSha);
      return textResult(pullView(forge, repo, pull, true));
    }
    case 'merge_pull_request': {
      const owner = needString(args, 'owner');
      const repoName = needString(args, 'repo');
      const rawNumber = args.pull_number ?? args.pullNumber ?? args.number;
      const number = typeof rawNumber === 'number' ? rawNumber : Number.parseInt(String(rawNumber ?? ''), 10);
      if (!Number.isInteger(number) || number <= 0) throw new ToolFault(-32602, 'Missing required argument: pull_number');
      const repo = needRepo(forge, owner, repoName);
      const pull = repo.pulls.get(number);
      if (!pull) return errorResult(`Pull request #${number} not found`);
      const result = forge.mergePullRequest(repo, pull, 'squash', `${pull.title} (#${pull.number})`);
      if ('conflict' in result) return errorResult('Merge conflict: the pull request cannot be merged cleanly');
      if ('error' in result) return errorResult(result.error);
      return textResult({ sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    }
    default:
      throw new ToolFault(-32602, `Unknown tool: ${name}`);
  }
}

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpResult {
  status: number;
  body: unknown;
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcOk(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function handleOne(forge: Forge, request: RpcRequest): Record<string, unknown> | null {
  const id = request.id === undefined ? null : request.id;
  const method = request.method ?? '';
  const isNotification = request.id === undefined;

  if (method.startsWith('notifications/')) return null; // 202, empty body

  if (method === 'server/discover') {
    return rpcOk(id, {
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const offered = (request.params?.protocolVersion as string | undefined) ?? '';
    const chosen = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return rpcOk(id, {
      protocolVersion: chosen,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'ping') return rpcOk(id, {});

  if (method === 'tools/list') {
    return rpcOk(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const params = request.params ?? {};
    const toolName = params.name as string | undefined;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!toolName) return rpcError(id, -32602, 'Missing required argument: name');
    try {
      return rpcOk(id, callTool(forge, toolName, args));
    } catch (error) {
      if (error instanceof ToolFault) return rpcError(id, error.code, error.message);
      return rpcError(id, -32603, error instanceof Error ? error.message : String(error));
    }
  }

  if (isNotification) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export function handleMcp(forge: Forge, rawBody: string): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const responses: unknown[] = [];
    for (const item of parsed) {
      const response = handleOne(forge, (item ?? {}) as RpcRequest);
      if (response !== null) responses.push(response);
    }
    return { status: 200, body: responses };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const response = handleOne(forge, parsed as RpcRequest);
  if (response === null) return { status: 202, body: null };
  return { status: 200, body: response };
}
