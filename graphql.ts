// GraphQL v4 surface: a small recursive-descent parser plus an executor over the
// same in-memory store the REST API uses. Supports queries, mutations, variables,
// aliases, arguments (including input objects and enums), inline fragments and
// named fragments. Introspection answers the __type queries the suite issues.

import { commentGlobalId, decodeGlobalId, issueGlobalId, pullGlobalId, repoGlobalId } from './ids.ts';
import type { Forge, Issue, PullRequest, Repo } from './store.ts';

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

const PUNCT = new Set(['{', '}', '(', ')', ':', '$', '!', '[', ']', '=', '@', '|', '&']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, value: string): void => {
    tokens.push({ kind, value });
  };
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      push('punct', '...');
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      push('punct', ch);
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' }[esc] ?? esc;
            j += 2;
          }
        } else {
          out += source[j];
          j++;
        }
      }
      push('string', out);
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (source[j] === '-') j++;
      while (j < source.length && /[0-9]/.test(source[j]!)) j++;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j++;
        while (j < source.length && /[0-9]/.test(source[j]!)) j++;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j++;
        if (source[j] === '+' || source[j] === '-') j++;
        while (j < source.length && /[0-9]/.test(source[j]!)) j++;
      }
      push(isFloat ? 'float' : 'int', source.slice(i, j));
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j]!)) j++;
      push('name', source.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  push('eof', '');
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'inline';
  typeName: string | null;
  selections: SelectionNode[];
}

interface SpreadNode {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | FragmentNode | SpreadNode;

interface VarDef {
  name: string;
  defaultValue: ValueNode | null;
}

interface Operation {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  varDefs: VarDef[];
  selections: SelectionNode[];
}

interface FragmentDef {
  name: string;
  typeName: string;
  selections: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected '${value}' but got '${token.value}'`);
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const kind = this.next().value as Operation['kind'];
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefs = this.parseVarDefs();
        this.skipDirectives();
        operations.push({ kind, name, varDefs, selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.next().value;
        const on = this.next();
        if (on.value !== 'on') throw new Error("Expected 'on' in fragment definition");
        const typeName = this.next().value;
        this.skipDirectives();
        fragments.set(name, { name, typeName, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`Unexpected token '${token.value}' in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private parseVarDefs(): VarDef[] {
    const defs: VarDef[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.next().value;
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        this.skipDirectives();
        defs.push({ name, defaultValue });
      }
      this.expectPunct(')');
    }
    return defs;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.next();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeName = this.next().value;
        this.skipDirectives();
        return { kind: 'inline', typeName, selections: this.parseSelectionSet() };
      }
      if (token.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeName: null, selections: this.parseSelectionSet() };
    }
    const first = this.next();
    if (first.kind !== 'name') throw new Error(`Expected field name but got '${first.value}'`);
    let alias: string | null = null;
    let name = first.value;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const name = this.next().value;
        this.expectPunct(':');
        args.push({ name, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.next().value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.next().value;
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected value token '${token.value}'`);
  }
}

// ---------------------------------------------------------------------------------------------
// schema tables (introspection)
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'bodyHTML', 'bodyText', 'url', 'createdAt', 'updatedAt', 'closedAt',
    'author', 'labels', 'comments', 'repository', 'viewerDidAuthor', 'locked', 'activeLockReason', 'closed',
    'includesCreatedEdit', 'isPinned', 'reactionGroups', 'timelineItems', 'userContentEdits', 'participants',
    'projectCards', 'projectsV2', 'hovercard', 'resourcePath', 'assignees', 'milestone',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef',
    'baseRef', 'files', 'url', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'author', 'labels',
    'reviews', 'reviewRequests', 'commits', 'additions', 'deletions', 'changedFiles', 'isDraft', 'draft', 'locked',
    'viewerCanUpdate', 'repository', 'participants', 'timelineItems', 'projectCards', 'closingIssuesReferences',
    'suggestedReviewers', 'statusCheckRollup', 'mergeStateStatus', 'revertUrl', 'mergeableState', 'potentialMergeCommit',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled',
    'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt',
    'stargazerCount', 'forkCount', 'watcherCount', 'primaryLanguage', 'languages', 'branches', 'refs',
    'mentionableUsers', 'assignableUsers', 'labels', 'milestones', 'projects', 'discussions', 'releases',
    'deployments', 'environments', 'collaborators', 'licenseInfo', 'homepageUrl', 'isArchived', 'isDisabled',
    'isFork', 'isLocked', 'isMirror', 'isTemplate', 'visibility', 'viewerCanAdminister', 'viewerHasStarred',
    'watchers', 'repositoryTopics', 'codeOfConduct', 'contactLinks', 'fundingLinks', 'securityPolicyUrl',
    'squashMergeAllowed', 'mergeCommitAllowed', 'rebaseMergeAllowed', 'deleteBranchOnMerge', 'hasProjectsEnabled',
    'hasWikiEnabled', 'hasDiscussionsEnabled', 'hasSponsorshipsEnabled', 'openGraphImageUrl', 'diskUsage', 'pushedAt',
  ],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'bio', 'company', 'location', 'createdAt', 'updatedAt', 'isViewer', 'viewerIsFollowing', 'followers', 'following', 'repositories', 'status', 'websiteUrl'],
  Ref: ['id', 'name', 'prefix', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit', 'codeOfConduct', 'codesOfConduct', 'license', 'licenses', 'marketplaceCategories', 'marketplaceCategory', 'marketplaceListing', 'marketplaceListings', 'meta', 'organization', 'organizations', 'relay', 'repositoryOwner', 'resource', 'topic', 'user', 'users', 'viewerCanSeeEmojis'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'createRepository', 'updateIssue', 'reopenIssue', 'closePullRequest', 'updatePullRequest', 'deleteIssueComment', 'updateIssueComment', 'addReaction', 'removeReaction', 'addStar', 'removeStar', 'createBranch', 'deleteBranch', 'updateRef', 'createRef'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['COMMIT', 'DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['COMMENTS', 'CREATED_AT', 'UPDATED_AT'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  MergeStateStatus: ['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE'],
  PullRequestMergeMethod: ['MERGE', 'REBASE', 'SQUASH'],
};

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

type GqlValue = string | number | boolean | null | GqlObject | GqlValue[];
type GqlObject = { __type: string; [key: string]: unknown };

interface GqlError {
  message: string;
  path?: Array<string | number>;
}

class Executor {
  private errors: GqlError[] = [];
  private readonly forge: Forge;
  private readonly document: Document;
  private readonly variables: Record<string, unknown>;

  constructor(forge: Forge, document: Document, variables: Record<string, unknown>) {
    this.forge = forge;
    this.document = document;
    this.variables = variables;
  }

  run(operation: Operation): { data: Record<string, unknown>; errors?: GqlError[] } {
    const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    const root: GqlObject = { __type: rootType };
    const data = this.executeSelectionSet(root, operation.selections, []) as Record<string, unknown>;
    if (this.errors.length > 0) return { data, errors: this.errors };
    return { data };
  }

  private resolveValue(node: ValueNode): unknown {
    return valueFromNode(node, this.variables);
  }

  private argsOf(field: FieldNode): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const arg of field.args) out[arg.name] = this.resolveValue(arg.value);
    return out;
  }

  private executeSelectionSet(object: GqlObject, selections: SelectionNode[], path: Array<string | number>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'spread') {
        const fragment = this.document.fragments.get(selection.name);
        if (fragment && fragment.typeName === object.__type) {
          Object.assign(out, this.executeSelectionSet(object, fragment.selections, path));
        }
        continue;
      }
      if (selection.kind === 'inline') {
        if (selection.typeName === null || selection.typeName === object.__type) {
          Object.assign(out, this.executeSelectionSet(object, selection.selections, path));
        }
        continue;
      }
      const key = selection.alias ?? selection.name;
      const fieldPath = [...path, key];
      const value = this.executeField(object, selection, fieldPath);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  private executeField(object: GqlObject, field: FieldNode, path: Array<string | number>): unknown {
    const typeName = object.__type;
    if (field.name === '__typename') return typeName;
    const allowed = TYPE_FIELDS[typeName];
    if (!field.name.startsWith('__') && allowed !== undefined && !allowed.includes(field.name)) {
      this.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".`, path });
      return undefined;
    }
    const args = this.argsOf(field);
    let value: unknown;
    try {
      value = this.resolveField(object, field.name, args);
    } catch (error) {
      this.errors.push({ message: error instanceof Error ? error.message : String(error), path });
      return undefined;
    }
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) {
      if (field.selections === null) return value;
      return value.map((item, index) => this.wrapValue(item, field.selections, [...path, index]));
    }
    if (typeof value === 'object') {
      if (field.selections === null) return value;
      return this.wrapValue(value, field.selections, path);
    }
    return value;
  }

  private wrapValue(value: unknown, selections: SelectionNode[] | null, path: Array<string | number>): unknown {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || Array.isArray(value)) return value;
    if (selections === null) return value;
    return this.executeSelectionSet(value as GqlObject, selections, path);
  }

  // -------------------------------------------------------------------------------------------
  // field resolvers
  // -------------------------------------------------------------------------------------------

  private resolveField(object: GqlObject, name: string, args: Record<string, unknown>): unknown {
    switch (object.__type) {
      case 'Query':
        return this.resolveQuery(name, args);
      case 'Mutation':
        return this.resolveMutation(name, args);
      case 'Repository':
        return this.resolveRepository(object, name, args);
      case 'Issue':
        return this.resolveIssue(object, name);
      case 'PullRequest':
        return this.resolvePullRequest(object, name, args);
      case 'User':
        return this.resolveUser(object, name);
      case 'Ref':
        return (object as Record<string, unknown>)[name] ?? null;
      case 'IssueConnection':
      case 'PullRequestConnection':
      case 'PullRequestChangedFileConnection':
        return this.resolveConnection(object, name);
      case 'PullRequestChangedFile':
        return (object as Record<string, unknown>)[name] ?? null;
      case 'PageInfo':
        return (object as Record<string, unknown>)[name] ?? null;
      case 'IssueComment':
        return this.resolveComment(object, name);
      case 'IssueCommentEdge':
        return name === 'node' ? object.node : name === 'cursor' ? object.cursor : null;
      case 'CreateIssuePayload':
      case 'CloseIssuePayload':
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload':
      case 'AddCommentPayload':
        return this.resolvePayload(object, name);
      case '__Type':
        return this.resolveType(object, name, args);
      case '__Field':
      case '__EnumValue':
        return (object as Record<string, unknown>)[name] ?? null;
      default:
        return (object as Record<string, unknown>)[name] ?? null;
    }
  }

  private resolveQuery(name: string, args: Record<string, unknown>): unknown {
    if (name === 'viewer') return this.userObject(this.forge.viewerLogin);
    if (name === 'repository') {
      const owner = String(args.owner ?? '');
      const repoName = String(args.name ?? '');
      const repo = this.forge.getRepo(owner, repoName);
      return repo ? this.repoObject(repo) : null;
    }
    if (name === 'node') {
      const id = String(args.id ?? '');
      return this.nodeObject(id);
    }
    if (name === '__type') {
      const typeName = String(args.name ?? '');
      if (TYPE_FIELDS[typeName] !== undefined || ENUM_VALUES[typeName] !== undefined) {
        return { __type: '__Type', name: typeName };
      }
      return null;
    }
    return null;
  }

  private resolveMutation(name: string, args: Record<string, unknown>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const clientMutationId = (input.clientMutationId as string | undefined) ?? null;
    if (name === 'createIssue') {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (!decoded || decoded.kind !== 'repo') throw new Error('repositoryId is invalid');
      const repo = this.forge.getRepo(decoded.owner, decoded.name);
      if (!repo) throw new Error('Repository not found');
      const title = String(input.title ?? '');
      if (!title) throw new Error('title is required');
      const issue = this.forge.createIssue(repo, title, (input.body as string | undefined) ?? '', []);
      return { __type: 'CreateIssuePayload', issue: this.issueObject(repo, issue), clientMutationId };
    }
    if (name === 'closeIssue') {
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (!decoded || decoded.kind !== 'issue' || decoded.number === undefined) throw new Error('issueId is invalid');
      const repo = this.forge.getRepo(decoded.owner, decoded.name);
      const issue = repo?.issues.get(decoded.number);
      if (!repo || !issue) throw new Error('Issue not found');
      issue.state = 'closed';
      issue.closedAt = this.forge.nowIso;
      issue.updatedAt = this.forge.nowIso;
      issue.cachedView = null;
      issue.cachedBytes = null;
      return { __type: 'CloseIssuePayload', issue: this.issueObject(repo, issue), clientMutationId };
    }
    if (name === 'createPullRequest') {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (!decoded || decoded.kind !== 'repo') throw new Error('repositoryId is invalid');
      const repo = this.forge.getRepo(decoded.owner, decoded.name);
      if (!repo) throw new Error('Repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headSha = this.forge.resolveCommit(repo, head);
      const baseSha = this.forge.resolveCommit(repo, base);
      if (!headSha || !baseSha) throw new Error('head or base branch does not exist');
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          throw new Error('A pull request already exists for this head and base');
        }
      }
      const pull = this.forge.createPull(repo, String(input.title ?? ''), (input.body as string | undefined) ?? '', head, base, headSha, baseSha);
      return { __type: 'CreatePullRequestPayload', pullRequest: this.pullObject(repo, pull), clientMutationId };
    }
    if (name === 'mergePullRequest') {
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (!decoded || decoded.kind !== 'pull' || decoded.number === undefined) throw new Error('pullRequestId is invalid');
      const repo = this.forge.getRepo(decoded.owner, decoded.name);
      const pull = repo?.pulls.get(decoded.number);
      if (!repo || !pull) throw new Error('Pull request not found');
      const method = String(input.mergeMethod ?? 'SQUASH').toLowerCase();
      const message = (input.commitHeadline as string | undefined) ?? `${pull.title} (#${pull.number})`;
      const result = this.forge.mergePullRequest(repo, pull, method, message);
      if ('conflict' in result) throw new Error('Merge conflict: the pull request cannot be merged cleanly');
      if ('error' in result) throw new Error(result.error);
      return { __type: 'MergePullRequestPayload', pullRequest: this.pullObject(repo, pull), clientMutationId };
    }
    if (name === 'addComment') {
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (!decoded || decoded.number === undefined) throw new Error('subjectId is invalid');
      const repo = this.forge.getRepo(decoded.owner, decoded.name);
      const target = decoded.kind === 'issue' ? repo?.issues.get(decoded.number) : decoded.kind === 'pull' ? repo?.pulls.get(decoded.number) : undefined;
      if (!repo || !target) throw new Error('Subject not found');
      const comment = this.forge.addComment(target, String(input.body ?? ''));
      return {
        __type: 'AddCommentPayload',
        commentEdge: {
          __type: 'IssueCommentEdge',
          node: this.commentObject(repo, decoded.number, comment),
          cursor: Buffer.from(`comment:${comment.id}`, 'utf8').toString('base64'),
        },
        subject: this.issueObject(repo, target as Issue),
        clientMutationId,
      };
    }
    return null;
  }

  private resolveRepository(object: GqlObject, name: string, args: Record<string, unknown>): unknown {
    const repo = object.repo as Repo;
    switch (name) {
      case 'id':
        return repoGlobalId(repo.owner, repo.name);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return this.userObject(repo.owner);
      case 'defaultBranchRef':
        return { __type: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/' };
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.isPrivate;
      case 'url':
        return `https://github.com/${repo.owner}/${repo.name}`;
      case 'createdAt':
        return repo.createdAt;
      case 'updatedAt':
        return repo.updatedAt;
      case 'issue': {
        const number = Number(args.number);
        const issue = repo.issues.get(number);
        return issue ? this.issueObject(repo, issue) : null;
      }
      case 'issues':
        return this.issueConnection(repo, args);
      case 'pullRequests':
        return this.pullConnection(repo, args);
      case 'pullRequest': {
        const number = Number(args.number);
        const pull = repo.pulls.get(number);
        return pull ? this.pullObject(repo, pull) : null;
      }
      default:
        return null;
    }
  }

  private issueConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
    const states = (args.states as string[] | undefined) ?? null;
    const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
    const direction = String(orderBy.direction ?? 'ASC');
    let issues = [...repo.issues.values()];
    if (states) {
      const wanted = new Set(states);
      issues = issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
    }
    issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
    return this.paginateNumbers(issues, args, 'IssueConnection', (issue) => this.issueObject(repo, issue));
  }

  private pullConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
    const states = (args.states as string[] | undefined) ?? ['OPEN'];
    const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
    const direction = String(orderBy.direction ?? 'DESC');
    const wanted = new Set(states);
    let pulls = [...repo.pulls.values()].filter((pull) => {
      const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      return wanted.has(state);
    });
    pulls.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
    return this.paginateNumbers(pulls, args, 'PullRequestConnection', (pull) => this.pullObject(repo, pull));
  }

  private paginateNumbers<T extends { number: number }>(
    items: T[],
    args: Record<string, unknown>,
    typeName: string,
    map: (item: T) => GqlObject,
  ): GqlObject {
    const first = args.first === undefined || args.first === null ? items.length : Number(args.first);
    const afterRaw = args.after as string | null | undefined;
    let start = 0;
    if (afterRaw) {
      const decoded = Buffer.from(afterRaw, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match) {
        const afterNumber = Number(match[1]);
        const index = items.findIndex((item) => item.number === afterNumber);
        start = index >= 0 ? index + 1 : items.length;
      }
    }
    const slice = items.slice(start, start + Math.max(0, first));
    const hasNextPage = start + slice.length < items.length;
    const endCursor = slice.length > 0 ? Buffer.from(`cursor:${slice[slice.length - 1]!.number}`, 'utf8').toString('base64') : null;
    const startCursor = slice.length > 0 ? Buffer.from(`cursor:${slice[0]!.number}`, 'utf8').toString('base64') : null;
    return {
      __type: typeName,
      nodes: slice.map(map),
      totalCount: items.length,
      pageInfo: {
        __type: 'PageInfo',
        hasNextPage,
        hasPreviousPage: start > 0,
        startCursor,
        endCursor,
      },
    };
  }

  private resolveIssue(object: GqlObject, name: string): unknown {
    const issue = object.issue as Issue;
    switch (name) {
      case 'id':
        return (object as Record<string, unknown>).gid;
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'body':
        return issue.body;
      case 'url':
        return `https://github.com/${object.owner}/${object.repoName}/issues/${issue.number}`;
      case 'createdAt':
        return issue.createdAt;
      case 'updatedAt':
        return issue.updatedAt;
      case 'closedAt':
        return issue.closedAt;
      default:
        return null;
    }
  }

  private resolvePullRequest(object: GqlObject, name: string, args: Record<string, unknown>): unknown {
    const repo = object.repo as Repo;
    const pull = object.pull as PullRequest;
    switch (name) {
      case 'id':
        return (object as Record<string, unknown>).gid;
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged':
        return pull.merged;
      case 'mergeable':
        if (pull.state !== 'open') return 'UNKNOWN';
        return this.forge.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'headRef':
        return { __type: 'Ref', name: pull.headRef, prefix: 'refs/heads/' };
      case 'baseRef':
        return { __type: 'Ref', name: pull.baseRef, prefix: 'refs/heads/' };
      case 'url':
        return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'createdAt':
        return pull.createdAt;
      case 'updatedAt':
        return pull.updatedAt;
      case 'closedAt':
        return pull.closedAt;
      case 'mergedAt':
        return pull.mergedAt;
      case 'files': {
        const files = this.forge.diffPull(repo, pull);
        const first = args.first === undefined || args.first === null ? files.length : Number(args.first);
        const slice = files.slice(0, Math.max(0, first));
        return {
          __type: 'PullRequestChangedFileConnection',
          nodes: slice.map((file) => ({
            __type: 'PullRequestChangedFile',
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
          })),
          totalCount: files.length,
          pageInfo: { __type: 'PageInfo', hasNextPage: slice.length < files.length, hasPreviousPage: false, startCursor: null, endCursor: null },
        };
      }
      default:
        return null;
    }
  }

  private resolveUser(object: GqlObject, name: string): unknown {
    const login = String(object.login);
    const known = [this.forge.identity.viewer, this.forge.identity.teammate, this.forge.identity.stranger].find((u) => u.login === login);
    switch (name) {
      case 'id':
        return Buffer.from(`U:${login}`, 'utf8').toString('base64');
      case 'login':
        return login;
      case 'name':
        return known?.name ?? login;
      case 'email':
        return known?.email ?? `${login}@example.invalid`;
      case 'url':
        return `https://github.com/${login}`;
      default:
        return null;
    }
  }

  private resolveConnection(object: GqlObject, name: string): unknown {
    if (name === 'nodes') return object.nodes ?? [];
    if (name === 'pageInfo') return object.pageInfo ?? null;
    if (name === 'totalCount') return object.totalCount ?? 0;
    if (name === 'edges') {
      const nodes = (object.nodes ?? []) as GqlObject[];
      return nodes.map((node) => ({ __type: 'Edge', node, cursor: null }));
    }
    return null;
  }

  private resolveComment(object: GqlObject, name: string): unknown {
    const comment = object.comment as { id: number; body: string; userLogin: string; createdAt: string; updatedAt: string };
    switch (name) {
      case 'id':
        return (object as Record<string, unknown>).gid;
      case 'body':
        return comment.body;
      case 'author':
        return this.userObject(comment.userLogin);
      case 'createdAt':
        return comment.createdAt;
      case 'updatedAt':
        return comment.updatedAt;
      default:
        return null;
    }
  }

  private resolvePayload(object: GqlObject, name: string): unknown {
    if (name === 'clientMutationId') return object.clientMutationId ?? null;
    return (object as Record<string, unknown>)[name] ?? null;
  }

  private resolveType(object: GqlObject, name: string, args: Record<string, unknown>): unknown {
    const typeName = String(object.name);
    if (name === 'name') return typeName;
    if (name === 'kind') return ENUM_VALUES[typeName] !== undefined ? 'ENUM' : 'OBJECT';
    if (name === 'description') return null;
    if (name === 'fields') {
      const fields = TYPE_FIELDS[typeName] ?? [];
      return fields.map((fieldName) => ({ __type: '__Field', name: fieldName, description: null }));
    }
    if (name === 'enumValues') {
      const values = ENUM_VALUES[typeName] ?? [];
      return values.map((value) => ({ __type: '__EnumValue', name: value, description: null }));
    }
    void args;
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // object constructors
  // -------------------------------------------------------------------------------------------

  private userObject(login: string): GqlObject {
    return { __type: 'User', login };
  }

  private repoObject(repo: Repo): GqlObject {
    return { __type: 'Repository', repo };
  }

  private issueObject(repo: Repo, issue: Issue): GqlObject {
    return {
      __type: 'Issue',
      issue,
      owner: repo.owner,
      repoName: repo.name,
      gid: issueGlobalId(repo.owner, repo.name, issue.number),
    };
  }

  private pullObject(repo: Repo, pull: PullRequest): GqlObject {
    return {
      __type: 'PullRequest',
      repo,
      pull,
      gid: pullGlobalId(repo.owner, repo.name, pull.number),
    };
  }

  private commentObject(repo: Repo, number: number, comment: { id: number; body: string; userLogin: string; createdAt: string; updatedAt: string }): GqlObject {
    return {
      __type: 'IssueComment',
      comment,
      gid: commentGlobalId(repo.owner, repo.name, number, comment.id),
    };
  }

  private nodeObject(id: string): GqlObject | null {
    const decoded = decodeGlobalId(id);
    if (!decoded) return null;
    const repo = this.forge.getRepo(decoded.owner, decoded.name);
    if (!repo) return null;
    if (decoded.kind === 'repo') return this.repoObject(repo);
    if (decoded.kind === 'issue' && decoded.number !== undefined) {
      const issue = repo.issues.get(decoded.number);
      return issue ? this.issueObject(repo, issue) : null;
    }
    if (decoded.kind === 'pull' && decoded.number !== undefined) {
      const pull = repo.pulls.get(decoded.number);
      return pull ? this.pullObject(repo, pull) : null;
    }
    if (decoded.kind === 'comment' && decoded.number !== undefined && decoded.commentId !== undefined) {
      const issue = repo.issues.get(decoded.number);
      const comment = issue?.comments.find((c) => c.id === decoded.commentId);
      return comment ? this.commentObject(repo, decoded.number, comment) : null;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

function valueFromNode(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => valueFromNode(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromNode(field.value, variables);
      return out;
    }
  }
}

export interface GraphqlResult {
  status: number;
  body: unknown;
}

export function handleGraphql(forge: Forge, body: unknown): GraphqlResult {
  const requests = Array.isArray(body) ? body : [body];
  const results: unknown[] = [];
  for (const request of requests) {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      results.push({ errors: [{ message: 'Request body must be a JSON object with a query field' }] });
      continue;
    }
    const { query, variables, operationName } = request as Record<string, unknown>;
    if (typeof query !== 'string') {
      results.push({ errors: [{ message: 'query must be a string' }] });
      continue;
    }
    let document: Document;
    try {
      document = new Parser(lex(query)).parseDocument();
    } catch (error) {
      results.push({ errors: [{ message: error instanceof Error ? error.message : String(error) }] });
      continue;
    }
    let operation: Operation | undefined;
    if (typeof operationName === 'string') {
      operation = document.operations.find((op) => op.name === operationName);
    } else {
      operation = document.operations[0];
    }
    if (!operation) {
      results.push({ errors: [{ message: 'No operation found in document' }] });
      continue;
    }
    const vars: Record<string, unknown> = {};
    for (const def of operation.varDefs) {
      const provided = (variables as Record<string, unknown> | undefined)?.[def.name];
      if (provided !== undefined) vars[def.name] = provided;
      else if (def.defaultValue) vars[def.name] = valueFromNode(def.defaultValue, {});
    }
    const executor = new Executor(forge, document, vars);
    results.push(executor.run(operation));
  }
  return { status: 200, body: Array.isArray(body) ? results : results[0] };
}
