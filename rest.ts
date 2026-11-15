// GitHub REST v3: repositories, branches, commits, contents, issues, comments,
// labels and pull requests. Every handler answers JSON; errors carry a string
// `message`. A repository under any owner but the token owner's login is a 404,
// never a 403.

import { parseCommit, storeObject } from './gitobj.ts';
import { commentGlobalId, issueGlobalId, pullGlobalId, repoGlobalId } from './ids.ts';
import type { Forge, Issue, Label, PullRequest, Repo } from './store.ts';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RestContext {
  forge: Forge;
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  host: string;
}

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** Pre-serialized JSON payload; when present it is sent verbatim. */
  raw?: string;
  /** Pre-serialized JSON payload bytes; when present they are sent verbatim. */
  rawBytes?: Buffer;
}

function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bodyObject(ctx: RestContext): Record<string, unknown> {
  if (ctx.body === undefined || ctx.body === null) return {};
  if (!isRecord(ctx.body)) fail(400, 'request body must be a JSON object');
  return ctx.body;
}

function reqString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------------------------

export function userView(forge: Forge, login: string): Record<string, unknown> {
  const identity = forge.identity;
  const known = login === identity.viewer.login ? identity.viewer : login === identity.teammate.login ? identity.teammate : login === identity.stranger.login ? identity.stranger : null;
  return {
    login,
    id: known?.id ?? 1,
    name: known?.name ?? login,
    email: known?.email ?? `${login}@example.invalid`,
    type: 'User',
    site_admin: false,
  };
}

export function repoView(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo.owner, repo.name),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userView(forge, repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    language: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
  };
}

function labelView(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

export function issueView(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  if (issue.cachedView) return issue.cachedView;
  const view: Record<string, unknown> = {
    id: issue.id,
    node_id: issueGlobalId(repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userView(forge, issue.userLogin),
    labels: issue.labels.map(labelView),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
  issue.cachedView = view;
  return view;
}

function pullAsIssueView(forge: Forge, repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pullGlobalId(repo.owner, repo.name, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: userView(forge, pull.userLogin),
    labels: [],
    comments: 0,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    pull_request: { url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}` },
  };
}

export function pullView(forge: Forge, repo: Repo, pull: PullRequest, withMergeable: boolean): Record<string, unknown> {
  const tips = forge.pullTips(repo, pull);
  return {
    id: pull.id,
    node_id: pullGlobalId(repo.owner, repo.name, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: userView(forge, pull.userLogin),
    head: {
      ref: pull.headRef,
      sha: tips.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: userView(forge, repo.owner),
      repo: repoView(forge, repo),
    },
    base: {
      ref: pull.baseRef,
      sha: tips.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: userView(forge, repo.owner),
      repo: repoView(forge, repo),
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: withMergeable ? forge.pullMergeable(repo, pull) : null,
    draft: false,
    comments: 0,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commentView(forge: Forge, repo: Repo, number: number, comment: { id: number; body: string; userLogin: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(repo.owner, repo.name, number, comment.id),
    body: comment.body,
    user: userView(forge, comment.userLogin),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

function commitView(forge: Forge, repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid)!;
  const commit = parseCommit(object.data);
  const authorLine = commit.author;
  const name = authorLine.slice(0, authorLine.lastIndexOf(' <'));
  const email = authorLine.slice(authorLine.lastIndexOf('<') + 1, authorLine.lastIndexOf('>'));
  return {
    sha: oid,
    node_id: Buffer.from(`C:${oid}`, 'utf8').toString('base64'),
    commit: {
      message: commit.message,
      author: { name, email, date: forge.nowIso },
      committer: { name, email, date: forge.nowIso },
      tree: { sha: commit.tree },
    },
    author: userView(forge, forge.viewerLogin),
    committer: userView(forge, forge.viewerLogin),
    parents: commit.parents.map((sha) => ({ sha })),
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const raw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Math.min(100, Math.max(1, Number.isFinite(raw) ? raw : 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], query: URLSearchParams, path: string, host: string): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(query);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `http://${host}/api/v3${path}?${params.toString()}`;
  };
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { page: items.slice(start, start + perPage), headers: { link: links.join(', ') } };
}

// ---------------------------------------------------------------------------------------------
// repo resolution
// ---------------------------------------------------------------------------------------------

function needRepo(ctx: RestContext, owner: string, name: string): Repo {
  const repo = ctx.forge.getRepo(owner, name);
  if (!repo) fail(404, 'Not Found');
  return repo;
}

function parseNumber(segment: string): number {
  const n = Number(segment);
  if (!Number.isInteger(n) || n <= 0) fail(404, 'Not Found');
  return n;
}

// ---------------------------------------------------------------------------------------------
// top-level routes
// ---------------------------------------------------------------------------------------------

function handleRoot(ctx: RestContext): RestResult {
  return {
    status: 200,
    body: {
      current_user_url: '/api/v3/user',
      authorizations_url: '/api/v3/authorizations',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    },
    headers: { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': 'repo, read:org' },
  };
}

function handleMeta(): RestResult {
  return {
    status: 200,
    body: {
      verifiable_password_authentication: true,
      installed_version: '1.0.0',
      ssh_key_fingerprints: {},
      hooks: [],
      git: [],
      packages: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
    },
  };
}

// ---------------------------------------------------------------------------------------------
// user routes
// ---------------------------------------------------------------------------------------------

function handleUser(ctx: RestContext): RestResult {
  const viewer = ctx.forge.identity.viewer;
  return { status: 200, body: { ...userView(ctx.forge, viewer.login), type: 'User' } };
}

function handleUserRepos(ctx: RestContext): RestResult {
  const { forge, method } = ctx;
  if (method === 'GET') {
    const repos = forge.listReposByOwner(forge.viewerLogin);
    const path = '/user/repos';
    const { page, headers } = paginate(repos, ctx.query, path, ctx.host);
    return { status: 200, body: page.map((repo) => repoView(forge, repo)), headers };
  }
  if (method === 'POST') {
    const body = bodyObject(ctx);
    const name = reqString(body, 'name');
    if (!name) fail(422, 'name is required');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) fail(422, 'name is invalid');
    const description = reqString(body, 'description') ?? '';
    const isPrivate = body.private === true;
    const repo = forge.createRepo(forge.viewerLogin, name, description, isPrivate);
    if (!repo) fail(422, `Repository '${name}' already exists`);
    return { status: 201, body: repoView(forge, repo) };
  }
  fail(405, 'Method Not Allowed');
}

// ---------------------------------------------------------------------------------------------
// repo routes
// ---------------------------------------------------------------------------------------------

function handleRepo(ctx: RestContext, owner: string, name: string): RestResult {
  const repo = needRepo(ctx, owner, name);
  if (ctx.method === 'GET') return { status: 200, body: repoView(ctx.forge, repo) };
  if (ctx.method === 'PATCH') {
    const body = bodyObject(ctx);
    const description = reqString(body, 'description');
    if (description !== undefined) repo.description = description;
    if (typeof body.private === 'boolean') repo.isPrivate = body.private;
    const defaultBranch = reqString(body, 'default_branch');
    if (defaultBranch !== undefined) {
      if (!repo.refs.has(`refs/heads/${defaultBranch}`)) fail(422, 'default branch does not exist');
      repo.defaultBranch = defaultBranch;
      ctx.forge.bumpGit(repo);
    }
    const newName = reqString(body, 'name');
    if (newName !== undefined && newName !== name) {
      if (ctx.forge.getRepo(owner, newName)) fail(422, `Repository '${newName}' already exists`);
      ctx.forge.repos.delete(ctx.forge.repoKey(owner, name));
      repo.name = newName;
      ctx.forge.repos.set(ctx.forge.repoKey(owner, newName), repo);
    }
    repo.updatedAt = ctx.forge.nowIso;
    return { status: 200, body: repoView(ctx.forge, repo) };
  }
  if (ctx.method === 'DELETE') {
    ctx.forge.deleteRepo(owner, name);
    return { status: 204, body: null };
  }
  fail(405, 'Method Not Allowed');
}

function handleBranches(ctx: RestContext, repo: Repo, rest: string[]): RestResult {
  if (rest.length === 0) {
    if (ctx.method !== 'GET') fail(405, 'Method Not Allowed');
    return {
      status: 200,
      body: ctx.forge.listBranches(repo).map((b) => ({ name: b.name, commit: { sha: b.sha }, protected: false })),
    };
  }
  if (ctx.method !== 'GET') fail(405, 'Method Not Allowed');
  const branch = rest.join('/');
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (!sha) fail(404, 'Branch not found');
  const peeled = ctx.forge.resolveCommit(repo, branch);
  const view: Record<string, unknown> = { name: branch, commit: { sha }, protected: false };
  if (peeled) {
    const commit = parseCommit(repo.objects.get(peeled)!.data);
    view.commit = { sha: peeled, commit: { message: commit.message } };
  }
  return { status: 200, body: view };
}

function handleCommits(ctx: RestContext, repo: Repo, rest: string[]): RestResult {
  if (rest.length > 0) {
    if (ctx.method !== 'GET') fail(405, 'Method Not Allowed');
    const sha = rest.join('/');
    const oid = ctx.forge.resolveCommit(repo, sha);
    if (!oid) fail(404, 'No commit found for SHA');
    return { status: 200, body: commitView(ctx.forge, repo, oid) };
  }
  if (ctx.method !== 'GET') fail(405, 'Method Not Allowed');
  const refish = ctx.query.get('sha') ?? repo.defaultBranch;
  const tip = ctx.forge.resolveCommit(repo, refish);
  if (!tip) {
    if (repo.refs.size === 0) fail(409, 'Git Repository is empty');
    fail(404, 'No commit found for SHA');
  }
  const { page, perPage } = pageParams(ctx.query);
  const oids = ctx.forge.listCommits(repo, tip, page * perPage);
  const { page: slice, headers } = paginate(oids, ctx.query, `/repos/${repo.owner}/${repo.name}/commits`, ctx.host);
  return { status: 200, body: slice.map((oid) => commitView(ctx.forge, repo, oid)), headers };
}

// ---------------------------------------------------------------------------------------------
// git refs
// ---------------------------------------------------------------------------------------------

function handleGitRefs(ctx: RestContext, repo: Repo, rest: string[]): RestResult {
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      const refs = [...repo.refs.keys()].sort().map((ref) => ({
        ref,
        object: { sha: repo.refs.get(ref), type: repo.objects.get(repo.refs.get(ref)!)?.type ?? 'commit' },
      }));
      return { status: 200, body: refs };
    }
    if (ctx.method === 'POST') {
      const body = bodyObject(ctx);
      const ref = reqString(body, 'ref');
      const sha = reqString(body, 'sha');
      if (!ref || !sha) fail(422, 'ref and sha are required');
      if (!ref.startsWith('refs/')) fail(422, 'ref must start with refs/');
      if (!repo.objects.has(sha)) fail(422, 'sha does not exist');
      if (repo.refs.has(ref)) fail(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      ctx.forge.bumpGit(repo);
      return { status: 201, body: { ref, object: { sha, type: repo.objects.get(sha)!.type } } };
    }
    fail(405, 'Method Not Allowed');
  }
  const ref = `refs/${rest.join('/')}`;
  if (ctx.method === 'GET') {
    const sha = repo.refs.get(ref);
    if (!sha) fail(404, 'Reference does not exist');
    return { status: 200, body: { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } } };
  }
  if (ctx.method === 'DELETE') {
    if (!repo.refs.has(ref)) fail(404, 'Reference does not exist');
    repo.refs.delete(ref);
    ctx.forge.bumpGit(repo);
    return { status: 204, body: null };
  }
  if (ctx.method === 'PATCH') {
    const body = bodyObject(ctx);
    const sha = reqString(body, 'sha');
    if (!sha || !repo.objects.has(sha)) fail(422, 'sha does not exist');
    if (!repo.refs.has(ref)) fail(404, 'Reference does not exist');
    repo.refs.set(ref, sha);
    ctx.forge.bumpGit(repo);
    return { status: 200, body: { ref, object: { sha, type: repo.objects.get(sha)!.type } } };
  }
  fail(405, 'Method Not Allowed');
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function contentsFileView(repo: Repo, path: string, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid)!;
  const name = path.split('/').pop()!;
  return {
    type: 'file',
    encoding: 'base64',
    size: object.data.length,
    name,
    path,
    sha: oid,
    content: object.data.toString('base64'),
  };
}

function handleContents(ctx: RestContext, repo: Repo, rest: string[]): RestResult {
  const forge = ctx.forge;
  const path = rest.join('/');
  if (ctx.method === 'GET') {
    const refish = ctx.query.get('ref') ?? repo.defaultBranch;
    const tip = forge.resolveCommit(repo, refish);
    if (!tip) fail(404, 'Not Found');
    const flat = forge.flattenTree(repo, tip);
    const entry = flat.get(path);
    if (path !== '' && entry) return { status: 200, body: contentsFileView(repo, path, entry.oid) };
    // Directory listing (root when path is empty).
    const prefix = path === '' ? '' : `${path}/`;
    const children = new Map<string, { oid: string; mode: string; isDir: boolean }>();
    for (const [filePath, value] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      const remainder = filePath.slice(prefix.length);
      const slash = remainder.indexOf('/');
      if (slash < 0) children.set(remainder, { oid: value.oid, mode: value.mode, isDir: false });
      else {
        const dir = remainder.slice(0, slash);
        if (!children.has(dir)) children.set(dir, { oid: '', mode: '40000', isDir: true });
      }
    }
    if (path !== '' && children.size === 0) fail(404, 'Not Found');
    const out: Record<string, unknown>[] = [];
    for (const name of [...children.keys()].sort()) {
      const child = children.get(name)!;
      const childPath = prefix + name;
      if (child.isDir) {
        const sub = new Map<string, { oid: string; mode: string }>();
        for (const [filePath, value] of flat) {
          if (filePath.startsWith(`${childPath}/`)) sub.set(filePath.slice(childPath.length + 1), value);
        }
        out.push({ type: 'dir', size: 0, name, path: childPath, sha: forge.buildTreeFromMap(repo, sub) });
      } else {
        const object = repo.objects.get(child.oid)!;
        out.push({ type: 'file', size: object.data.length, name, path: childPath, sha: child.oid });
      }
    }
    return { status: 200, body: out };
  }
  if (ctx.method === 'PUT') {
    const body = bodyObject(ctx);
    const message = reqString(body, 'message') ?? 'Update file';
    const content = reqString(body, 'content');
    if (content === undefined) fail(422, 'content is required');
    const branch = reqString(body, 'branch') ?? repo.defaultBranch;
    const givenSha = reqString(body, 'sha');
    let base = forge.resolveCommit(repo, branch);
    if (!base && branch !== repo.defaultBranch) base = forge.resolveCommit(repo, repo.defaultBranch);
    const flat = base ? forge.flattenTree(repo, base) : new Map<string, { oid: string; mode: string }>();
    const current = flat.get(path);
    if (givenSha !== undefined && current && givenSha !== current.oid) {
      fail(409, 'sha does not match the current file: the file has changed since it was read');
    }
    const bytes = Buffer.from(content, 'base64');
    const blobOid = storeObject(repo.objects, 'blob', bytes);
    flat.set(path, { oid: blobOid, mode: current?.mode ?? '100644' });
    const treeOid = forge.buildTreeFromMap(repo, flat);
    const commitOid = forge.commitOnBranch(repo, branch, message, treeOid, base ? [base] : []);
    const status = current ? 200 : 201;
    return {
      status,
      body: {
        content: contentsFileView(repo, path, blobOid),
        commit: { sha: commitOid, message, author: userView(forge, forge.viewerLogin) },
      },
    };
  }
  if (ctx.method === 'DELETE') {
    const body = bodyObject(ctx);
    const message = reqString(body, 'message') ?? 'Delete file';
    const branch = reqString(body, 'branch') ?? repo.defaultBranch;
    const givenSha = reqString(body, 'sha');
    const base = forge.resolveCommit(repo, branch);
    if (!base) fail(404, 'Not Found');
    const flat = forge.flattenTree(repo, base);
    const current = flat.get(path);
    if (!current) fail(404, 'Not Found');
    if (givenSha !== undefined && givenSha !== current.oid) fail(409, 'sha does not match the current file');
    flat.delete(path);
    const treeOid = forge.buildTreeFromMap(repo, flat);
    const commitOid = forge.commitOnBranch(repo, branch, message, treeOid, [base]);
    return { status: 200, body: { commit: { sha: commitOid, message } } };
  }
  fail(405, 'Method Not Allowed');
}

// ---------------------------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------------------------

function handleLabels(ctx: RestContext, repo: Repo, rest: string[]): RestResult {
  if (rest.length > 0) {
    if (ctx.method !== 'GET') fail(405, 'Method Not Allowed');
    const label = repo.labels.get(rest.join('/'));
    if (!label) fail(404, 'Label not found');
    return { status: 200, body: labelView(label) };
  }
  if (ctx.method === 'GET') {
    return { status: 200, body: [...repo.labels.values()].map(labelView) };
  }
  if (ctx.method === 'POST') {
    const body = bodyObject(ctx);
    const name = reqString(body, 'name');
    if (!name) fail(422, 'name is required');
    if (repo.labels.has(name)) fail(422, `Label '${name}' already exists`);
    const color = (reqString(body, 'color') ?? 'ededed').replace(/^#/, '');
    const label: Label = { name, color, description: reqString(body, 'description') ?? '' };
    repo.labels.set(name, label);
    return { status: 201, body: labelView(label) };
  }
  fail(405, 'Method Not Allowed');
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

function handleIssues(ctx: RestContext, repo: Repo, rest: string[]): RestResult {
  const forge = ctx.forge;
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      const labelFilter = (ctx.query.get('labels') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      type Row = { number: number; state: string; comments: number; view: Record<string, unknown> };
      const rows: Row[] = [];
      for (const issue of repo.issues.values()) {
        if (labelFilter.length > 0 && !labelFilter.every((l) => issue.labels.some((x) => x.name === l))) continue;
        rows.push({ number: issue.number, state: issue.state, comments: issue.comments.length, view: issueView(forge, repo, issue) });
      }
      for (const pull of repo.pulls.values()) {
        if (labelFilter.length > 0) continue;
        rows.push({ number: pull.number, state: pull.state, comments: 0, view: pullAsIssueView(forge, repo, pull) });
      }
      const filtered = state === 'all' ? rows : rows.filter((r) => r.state === state);
      const sorted = filtered.sort((a, b) => {
        const key = sort === 'comments' ? a.comments - b.comments : a.number - b.number;
        return direction === 'asc' ? key : -key;
      });
      const { page, headers } = paginate(sorted, ctx.query, `/repos/${repo.owner}/${repo.name}/issues`, ctx.host);
      return { status: 200, body: page.map((r) => r.view), headers };
    }
    if (ctx.method === 'POST') {
      const body = bodyObject(ctx);
      const title = reqString(body, 'title');
      if (!title) fail(422, 'title is required');
      const labelNames = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      const labels: Label[] = [];
      for (const name of labelNames) {
        const label = repo.labels.get(name);
        if (!label) fail(422, `label '${name}' does not exist`);
        labels.push(label);
      }
      const issue = forge.createIssue(repo, title, reqString(body, 'body') ?? '', labels);
      return { status: 201, body: issueView(forge, repo, issue) };
    }
    fail(405, 'Method Not Allowed');
  }
  const number = parseNumber(rest[0]!);
  const issue = repo.issues.get(number);
  const pull = repo.pulls.get(number);
  if (rest.length === 2 && rest[1] === 'comments') {
    if (!issue && !pull) fail(404, 'Not Found');
    if (ctx.method === 'GET') {
      const comments = issue ? issue.comments : pull!.comments;
      return { status: 200, body: comments.map((c) => commentView(forge, repo, number, c)) };
    }
    if (ctx.method === 'POST') {
      const body = bodyObject(ctx);
      const text = reqString(body, 'body');
      if (!text) fail(422, 'body is required');
      const comment = forge.addComment(issue ?? pull!, text);
      return { status: 201, body: commentView(forge, repo, number, comment) };
    }
    fail(405, 'Method Not Allowed');
  }
  if (rest.length > 1) fail(404, 'Not Found');
  if (ctx.method === 'GET') {
    if (issue) {
      if (issue.cachedBytes) return { status: 200, body: null, rawBytes: issue.cachedBytes };
      const bytes = Buffer.from(JSON.stringify(issueView(forge, repo, issue)), 'utf8');
      issue.cachedBytes = bytes;
      return { status: 200, body: null, rawBytes: bytes };
    }
    if (pull) return { status: 200, body: pullAsIssueView(forge, repo, pull) };
    fail(404, 'Not Found');
  }
  if (ctx.method === 'PATCH') {
    const body = bodyObject(ctx);
    if (issue) {
      const title = reqString(body, 'title');
      if (title !== undefined) issue.title = title;
      const text = reqString(body, 'body');
      if (text !== undefined) issue.body = text;
      const state = reqString(body, 'state');
      if (state !== undefined) {
        if (state !== 'open' && state !== 'closed') fail(422, 'state must be open or closed');
        issue.state = state;
        issue.closedAt = state === 'closed' ? forge.nowIso : null;
      }
      const labelNames = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : undefined;
      if (labelNames !== undefined) {
        const labels: Label[] = [];
        for (const name of labelNames) {
          const label = repo.labels.get(name);
          if (!label) fail(422, `label '${name}' does not exist`);
          labels.push(label);
        }
        issue.labels = labels;
      }
      issue.updatedAt = forge.nowIso;
      issue.cachedView = null;
      issue.cachedBytes = null;
      return { status: 200, body: issueView(forge, repo, issue) };
    }
    if (pull) {
      const title = reqString(body, 'title');
      if (title !== undefined) pull.title = title;
      const text = reqString(body, 'body');
      if (text !== undefined) pull.body = text;
      const state = reqString(body, 'state');
      if (state !== undefined) {
        if (state !== 'open' && state !== 'closed') fail(422, 'state must be open or closed');
        pull.state = state;
        pull.closedAt = state === 'closed' ? forge.nowIso : null;
      }
      pull.updatedAt = forge.nowIso;
      return { status: 200, body: pullAsIssueView(forge, repo, pull) };
    }
    fail(404, 'Not Found');
  }
  fail(405, 'Method Not Allowed');
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function stripOwnerPrefix(head: string, owner: string): string {
  const idx = head.indexOf(':');
  if (idx > 0) {
    const maybeOwner = head.slice(0, idx);
    if (maybeOwner === owner) return head.slice(idx + 1);
  }
  return head;
}

function handlePulls(ctx: RestContext, repo: Repo, rest: string[]): RestResult {
  const forge = ctx.forge;
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = ctx.query.get('direction') ?? 'desc';
      const sort = ctx.query.get('sort') ?? 'created';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
      pulls.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      void sort;
      const { page, headers } = paginate(pulls, ctx.query, `/repos/${repo.owner}/${repo.name}/pulls`, ctx.host);
      return { status: 200, body: page.map((p) => pullView(forge, repo, p, false)), headers };
    }
    if (ctx.method === 'POST') {
      const body = bodyObject(ctx);
      const title = reqString(body, 'title');
      if (!title) fail(422, 'title is required');
      const headRaw = reqString(body, 'head');
      const base = reqString(body, 'base');
      if (!headRaw || !base) fail(422, 'head and base are required');
      const head = stripOwnerPrefix(headRaw, repo.owner);
      if (head === base) fail(422, 'head and base must differ');
      const headSha = forge.resolveCommit(repo, head);
      if (!headSha) fail(422, 'head branch does not exist');
      const baseSha = forge.resolveCommit(repo, base);
      if (!baseSha) fail(422, 'base branch does not exist');
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          fail(422, 'A pull request already exists for this head and base');
        }
      }
      const pull = forge.createPull(repo, title, reqString(body, 'body') ?? '', head, base, headSha, baseSha);
      return { status: 201, body: pullView(forge, repo, pull, true) };
    }
    fail(405, 'Method Not Allowed');
  }
  const number = parseNumber(rest[0]!);
  const pull = repo.pulls.get(number);
  if (!pull) fail(404, 'Not Found');
  if (rest.length === 2 && rest[1] === 'files') {
    if (ctx.method !== 'GET') fail(405, 'Method Not Allowed');
    const files = forge.diffPull(repo, pull);
    return {
      status: 200,
      body: files.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
      })),
    };
  }
  if (rest.length === 2 && rest[1] === 'merge') {
    if (ctx.method === 'GET') {
      if (pull.merged) return { status: 204, body: null };
      fail(404, 'Not Found');
    }
    if (ctx.method !== 'PUT') fail(405, 'Method Not Allowed');
    const body = bodyObject(ctx);
    const method = (reqString(body, 'merge_method') ?? 'squash').toLowerCase();
    const message = reqString(body, 'commit_title') ?? `${pull.title} (#${pull.number})`;
    const result = forge.mergePullRequest(repo, pull, method, message);
    if ('conflict' in result) fail(405, 'Merge conflict: the pull request cannot be merged cleanly');
    if ('error' in result) fail(405, result.error);
    return { status: 200, body: { sha: result.sha, merged: true, message: 'Pull Request successfully merged' } };
  }
  if (rest.length > 1) fail(404, 'Not Found');
  if (ctx.method === 'GET') return { status: 200, body: pullView(forge, repo, pull, true) };
  if (ctx.method === 'PATCH') {
    const body = bodyObject(ctx);
    const title = reqString(body, 'title');
    if (title !== undefined) pull.title = title;
    const text = reqString(body, 'body');
    if (text !== undefined) pull.body = text;
    const state = reqString(body, 'state');
    if (state !== undefined) {
      if (state !== 'open' && state !== 'closed') fail(422, 'state must be open or closed');
      pull.state = state;
      pull.closedAt = state === 'closed' ? forge.nowIso : null;
    }
    pull.updatedAt = forge.nowIso;
    return { status: 200, body: pullView(forge, repo, pull, true) };
  }
  fail(405, 'Method Not Allowed');
}

// ---------------------------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------------------------

export function handleRest(ctx: RestContext): RestResult {
  const [first, ...rest] = ctx.segments;
  if (first === undefined || first === '') {
    if (ctx.method === 'GET') return handleRoot(ctx);
    fail(404, 'Not Found');
  }
  if (first === 'meta') {
    if (ctx.method === 'GET') return handleMeta();
    fail(404, 'Not Found');
  }
  if (first === 'user' && rest.length === 0) {
    if (ctx.method === 'GET') return handleUser(ctx);
    fail(404, 'Not Found');
  }
  if (first === 'user' && rest[0] === 'repos' && rest.length === 1) return handleUserRepos(ctx);
  if (first === 'repos' && rest.length >= 2) {
    const owner = rest[0]!;
    const name = rest[1]!;
    const tail = rest.slice(2);
    const repo = needRepo(ctx, owner, name);
    if (tail.length === 0) return handleRepo(ctx, owner, name);
    const [resource, ...resourceRest] = tail;
    if (resource === 'branches') return handleBranches(ctx, repo, resourceRest);
    if (resource === 'commits') return handleCommits(ctx, repo, resourceRest);
    if (resource === 'contents') return handleContents(ctx, repo, resourceRest);
    if (resource === 'git' && resourceRest[0] === 'refs') return handleGitRefs(ctx, repo, resourceRest.slice(1));
    if (resource === 'issues') return handleIssues(ctx, repo, resourceRest);
    if (resource === 'labels') return handleLabels(ctx, repo, resourceRest);
    if (resource === 'pulls') return handlePulls(ctx, repo, resourceRest);
    fail(404, 'Not Found');
  }
  fail(404, 'Not Found');
}
