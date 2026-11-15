// The forge's in-memory state: repositories, git objects and refs, issues, pull
// requests, labels and comments. One store per process; every surface (REST, git,
// GraphQL, MCP) reads and writes the same objects, so a change on one is visible on
// all the others at once.
//
// Each repository also carries the git wire caches (advertisements, ls-refs and
// fetch responses). They are pure functions of the repository's objects, refs and
// default branch, so every mutation of that state goes through bumpGit, which drops
// them. A missed bump would serve stale git bytes; every mutation site is enumerated
// here and in the git/REST handlers, and the conformance suite's interleaved
// push/fetch sequences are the check that none was missed.

import {
  buildCommitBytes,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  storeObject,
  ZERO_OID,
  type GitObject,
  type TreeEntry,
} from './gitobj.ts';
import type { ForgeIdentity } from './scenario.ts';

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Memoized REST view; cleared on any mutation of this issue. */
  cachedView: Record<string, unknown> | null;
  /** Memoized serialized single-issue response bytes; cleared with cachedView. */
  cachedBytes: Buffer | null;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headShaAtCreation: string;
  baseShaAtCreation: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  comments: IssueComment[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
  /** Generation of the git state (objects/refs/default branch); bumped by bumpGit. */
  gitVersion: number;
  /** Memoized info/refs advertisements, keyed by service; dropped by bumpGit. */
  advertCache: Map<string, Buffer>;
  /** Memoized ls-refs responses, keyed by argument list; dropped by bumpGit. */
  lsRefsCache: Map<string, Buffer>;
  /** Memoized fetch responses, keyed by negotiation; dropped by bumpGit. */
  fetchCache: Map<string, Buffer>;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export class Forge {
  readonly identity: ForgeIdentity;
  readonly nowIso: string;
  readonly nowEpoch: number;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private requestSeq = 0;

  constructor(identity: ForgeIdentity, nowIso: string) {
    this.identity = identity;
    this.nowIso = nowIso;
    const parsed = Date.parse(nowIso);
    this.nowEpoch = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1735689600;
  }

  get viewerLogin(): string {
    return this.identity.viewer.login;
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return `forge-${this.requestSeq}`;
  }

  /** The identity server-created commits carry. */
  commitWho(): string {
    return `${this.identity.viewer.name} <${this.identity.viewer.email}>`;
  }

  /**
   * Drop a repository's git wire caches after its objects, refs or default branch
   * changed. Call it from every mutation site; a stale cache is a wrong answer, a
   * needless bump only costs a rebuild.
   */
  bumpGit(repo: Repo): void {
    repo.gitVersion += 1;
    repo.advertCache.clear();
    repo.lsRefsCache.clear();
    repo.fetchCache.clear();
  }

  // -------------------------------------------------------------------------------------------
  // repositories
  // -------------------------------------------------------------------------------------------

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.getRepo(owner, name)) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
      gitVersion: 0,
      advertCache: new Map(),
      lsRefsCache: new Map(),
      fetchCache: new Map(),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // refs and objects
  // -------------------------------------------------------------------------------------------

  headRef(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** Resolve a ref-ish: HEAD, a full ref, a branch short name, or a commit id. */
  resolveRef(repo: Repo, refish: string): string | null {
    if (refish === 'HEAD') return repo.refs.get(this.headRef(repo)) ?? null;
    if (repo.refs.has(refish)) return repo.refs.get(refish)!;
    const branch = repo.refs.get(`refs/heads/${refish}`);
    if (branch) return branch;
    const tag = repo.refs.get(`refs/tags/${refish}`);
    if (tag) return tag;
    if (isObjectId(refish) && repo.objects.has(refish)) return refish;
    return null;
  }

  /** The commit a ref-ish names, peeling annotated tags. */
  resolveCommit(repo: Repo, refish: string): string | null {
    const oid = this.resolveRef(repo, refish);
    if (!oid) return null;
    const peeled = peelToCommit(repo.objects, oid);
    return repo.objects.get(peeled)?.type === 'commit' ? peeled : null;
  }

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** Flatten a commit's tree to path -> {oid, mode}. */
  flattenTree(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return out;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(parseCommit(commit.data).tree, '');
    return out;
  }

  /** Build nested trees from a flat path map, storing every object; returns the root tree id. */
  buildTreeFromMap(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, value] of flat) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i]!;
        let child = node.dirs.get(part);
        if (!child) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(part, child);
        }
        node = child;
      }
      node.files.set(parts[parts.length - 1]!, value);
    }
    const objectsBefore = repo.objects.size;
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return storeObject(repo.objects, 'tree', buildTree(entries));
    };
    const rootOid = build(root);
    if (repo.objects.size !== objectsBefore) this.bumpGit(repo);
    return rootOid;
  }

  /** Create a commit object on a branch (creating the branch when absent). */
  commitOnBranch(repo: Repo, branch: string, message: string, treeOid: string, parents: readonly string[]): string {
    const data = buildCommitBytes(treeOid, parents, message, this.commitWho(), this.nowEpoch);
    const oid = storeObject(repo.objects, 'commit', data);
    repo.refs.set(`refs/heads/${branch}`, oid);
    this.bumpGit(repo);
    return oid;
  }

  /** Commits reachable from a tip, newest first (depth-first, first-parent biased). */
  listCommits(repo: Repo, tip: string, limit: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length && out.length < limit) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
    }
    return out;
  }

  isAncestor(repo: Repo, tip: string, ancestor: string): boolean {
    return isAncestor(repo.objects, tip, ancestor);
  }

  mergeBase(repo: Repo, a: string, b: string): string | null {
    return mergeBase(repo.objects, a, b);
  }

  // -------------------------------------------------------------------------------------------
  // diffs and merges
  // -------------------------------------------------------------------------------------------

  private blobLines(repo: Repo, oid: string): string[] {
    const object = repo.objects.get(oid);
    if (!object) return [];
    const text = object.data.toString('utf8');
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /** Line counts between two blobs via LCS (files here are small; capped for safety). */
  private countLines(repo: Repo, oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
    if (oldOid === null && newOid === null) return { additions: 0, deletions: 0 };
    if (oldOid === null) return { additions: this.blobLines(repo, newOid!).length, deletions: 0 };
    if (newOid === null) return { additions: 0, deletions: this.blobLines(repo, oldOid).length };
    if (oldOid === newOid) return { additions: 0, deletions: 0 };
    const a = this.blobLines(repo, oldOid);
    const b = this.blobLines(repo, newOid);
    if (a.length * b.length > 250_000) return { additions: b.length, deletions: a.length };
    const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    const common = dp[0]![0]!;
    return { additions: b.length - common, deletions: a.length - common };
  }

  /** The merge-base -> head diff of a pull request, as file changes. */
  diffPull(repo: Repo, pull: PullRequest): FileChange[] {
    const baseTip = this.resolveCommit(repo, pull.baseRef);
    const headTip = this.resolveCommit(repo, pull.headRef);
    if (!baseTip || !headTip) return [];
    const base = this.mergeBase(repo, baseTip, headTip);
    const from = base ? this.flattenTree(repo, base) : new Map<string, { oid: string; mode: string }>();
    const to = this.flattenTree(repo, headTip);
    const paths = new Set<string>([...from.keys(), ...to.keys()]);
    const changes: FileChange[] = [];
    for (const path of [...paths].sort()) {
      const oldEntry = from.get(path);
      const newEntry = to.get(path);
      if (oldEntry && newEntry && oldEntry.oid === newEntry.oid) continue;
      const counts = this.countLines(repo, oldEntry?.oid ?? null, newEntry?.oid ?? null);
      const status = !oldEntry ? 'added' : !newEntry ? 'removed' : 'modified';
      changes.push({
        filename: path,
        status,
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
    return changes;
  }

  /**
   * The three-way merge of base/ours/theirs trees. Returns the merged flat map, or null
   * on conflict (both sides changed the same path differently, or one side deleted a
   * path the other changed).
   */
  threeWayMerge(
    base: Map<string, { oid: string; mode: string }>,
    ours: Map<string, { oid: string; mode: string }>,
    theirs: Map<string, { oid: string; mode: string }>,
  ): Map<string, { oid: string; mode: string }> | null {
    const merged = new Map<string, { oid: string; mode: string }>();
    const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      const same = (x?: { oid: string }, y?: { oid: string }): boolean =>
        (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
      if (same(o, t)) {
        if (o) merged.set(path, o);
      } else if (same(o, b)) {
        if (t) merged.set(path, t);
      } else if (same(t, b)) {
        if (o) merged.set(path, o);
      } else {
        return null;
      }
    }
    return merged;
  }

  /** Whether a pull request merges cleanly right now. */
  pullMergeable(repo: Repo, pull: PullRequest): boolean {
    if (pull.merged || pull.state !== 'open') return false;
    const baseTip = this.resolveCommit(repo, pull.baseRef);
    const headTip = this.resolveCommit(repo, pull.headRef);
    if (!baseTip || !headTip) return false;
    const base = this.mergeBase(repo, baseTip, headTip);
    const baseTree = base ? this.flattenTree(repo, base) : new Map();
    return this.threeWayMerge(baseTree, this.flattenTree(repo, baseTip), this.flattenTree(repo, headTip)) !== null;
  }

  // -------------------------------------------------------------------------------------------
  // issues and pull requests
  // -------------------------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      userLogin: this.viewerLogin,
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
      closedAt: null,
      cachedView: null,
      cachedBytes: null,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
    headSha: string,
    baseSha: string,
  ): PullRequest {
    const pull: PullRequest = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headShaAtCreation: headSha,
      baseShaAtCreation: baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      comments: [],
      userLogin: this.viewerLogin,
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
      closedAt: null,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** Shared squash/merge/rebase implementation used by REST and GraphQL. */
  mergePullRequest(
    repo: Repo,
    pull: PullRequest,
    method: string,
    message: string,
  ): { sha: string } | { conflict: true } | { error: string } {
    if (pull.merged) return { error: 'Pull Request is already merged' };
    if (pull.state !== 'open') return { error: 'Pull Request is closed' };
    const baseTip = this.resolveCommit(repo, pull.baseRef);
    const headTip = this.resolveCommit(repo, pull.headRef);
    if (!baseTip || !headTip) return { error: 'Head or base branch is missing' };
    const base = this.mergeBase(repo, baseTip, headTip);
    const baseTree = base ? this.flattenTree(repo, base) : new Map<string, { oid: string; mode: string }>();
    const merged = this.threeWayMerge(baseTree, this.flattenTree(repo, baseTip), this.flattenTree(repo, headTip));
    if (!merged) return { conflict: true };
    const treeOid = this.buildTreeFromMap(repo, merged);
    const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
    const sha = this.commitOnBranch(repo, pull.baseRef, message, treeOid, parents);
    pull.merged = true;
    pull.mergedAt = this.nowIso;
    pull.mergeCommitSha = sha;
    pull.state = 'closed';
    pull.closedAt = this.nowIso;
    pull.updatedAt = this.nowIso;
    return { sha };
  }

  addComment(target: Issue | PullRequest, body: string): IssueComment {
    const comment: IssueComment = {
      id: this.nextCommentId++,
      body,
      userLogin: this.viewerLogin,
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
    };
    target.comments.push(comment);
    if ('cachedView' in target) {
      target.cachedView = null;
      target.cachedBytes = null;
    }
    return comment;
  }

  /** Live head/base tips for a pull request, falling back to creation-time shas. */
  pullTips(repo: Repo, pull: PullRequest): { headSha: string; baseSha: string } {
    return {
      headSha: this.resolveCommit(repo, pull.headRef) ?? pull.headShaAtCreation,
      baseSha: this.resolveCommit(repo, pull.baseRef) ?? pull.baseShaAtCreation,
    };
  }

  /** All objects reachable from a repo's refs (used by fetch negotiation helpers). */
  reachableFrom(repo: Repo, roots: Iterable<string>): Set<string> {
    return collectReachable(roots, (oid) => repo.objects.get(oid), { allowMissing: true });
  }
}

export { ZERO_OID };
