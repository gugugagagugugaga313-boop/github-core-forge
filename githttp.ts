// git smart HTTP: protocol v2 and v0 upload-pack, v0 receive-pack. The wire shapes
// are the ones the suite's client speaks: v2 advertisements, ls-refs with server-side
// prefix filtering and peeling, fetch with shallow/deepen negotiation, and report-status
// pushes with per-ref fast-forward checks. No git binary; packs are built and read here.
//
// The wire answers are pure functions of the repository's git state, so they are
// cached per repository: the v2 advertisement is constant, v0/receive advertisements
// and ls-refs answers are memoized until the state moves, and whole fetch responses
// are memoized by their negotiation (wants/haves/shallow/depth). Forge.bumpGit drops
// all of them on any mutation; a cached answer is byte-identical to a fresh one.

import {
  collectReachable,
  decodePktLines,
  isObjectId,
  parseCommit,
  parseTag,
  peelToCommit,
  pktLine,
  pktLines,
  readPack,
  sidebandChunks,
  writePack,
  ZERO_OID,
  type GitObject,
  type Pkt,
} from './gitobj.ts';
import type { Forge, Repo } from './store.ts';

export const AGENT = 'github-core-forge/1.0';

/** Cap on memoized fetch responses per repository; clearing is deterministic. */
const FETCH_CACHE_MAX = 128;
/** Cap on memoized ls-refs responses per repository; clearing is deterministic. */
const LS_REFS_CACHE_MAX = 64;

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
}

/** All refs of a repo, sorted by name, with peeled targets for annotated tags. */
function refLines(repo: Repo): RefLine[] {
  const names = [...repo.refs.keys()].sort();
  const lines: RefLine[] = [];
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { name, oid };
    const object = repo.objects.get(oid);
    if (name.startsWith('refs/tags/') && object?.type === 'tag') {
      line.peeled = peelToCommit(repo.objects, oid);
    }
    lines.push(line);
  }
  return lines;
}

function headSymref(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------------------------------------
// advertisements (GET info/refs)
// ---------------------------------------------------------------------------------------------

/** The v2 capability advertisement: it names no refs, so it is the same for every repo. */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine('# service=git-upload-pack\n'),
  pktLines(['flush']),
  pktLines(['version 2\n', 'ls-refs=unborn\n', 'fetch=shallow\n', `agent=${AGENT}\n`, 'object-format=sha1\n', 'flush']),
]);

export function advertisementUploadPack(repo: Repo, version2: boolean): Buffer {
  if (version2) return V2_ADVERTISEMENT;
  const cached = repo.advertCache.get('up0');
  if (cached) return cached;
  const service = pktLine('# service=git-upload-pack\n');
  const caps = `symref=HEAD:${headSymref(repo)} side-band-64k shallow thin-pack ofs-delta agent=${AGENT}`;
  const lines: Array<string | 'flush'> = [];
  const refs = refLines(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const tip = repo.refs.get(headSymref(repo)) ?? refs[0]!.oid;
    lines.push(`${tip} HEAD\0${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  const built = Buffer.concat([service, pktLines(['flush']), pktLines(lines)]);
  repo.advertCache.set('up0', built);
  return built;
}

export function advertisementReceivePack(repo: Repo): Buffer {
  const cached = repo.advertCache.get('recv');
  if (cached) return cached;
  const service = pktLine('# service=git-receive-pack\n');
  const caps = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const lines: Array<string | 'flush'> = [];
  const refs = refLines(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const tip = repo.refs.get(headSymref(repo)) ?? refs[0]!.oid;
    lines.push(`${tip} HEAD\0${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  const built = Buffer.concat([service, pktLines(['flush']), pktLines(lines)]);
  repo.advertCache.set('recv', built);
  return built;
}

// ---------------------------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------------------------

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  const key = JSON.stringify(args);
  const cached = repo.lsRefsCache.get(key);
  if (cached) return cached;
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const refs = refLines(repo);
  const tip = repo.refs.get(headSymref(repo));
  if (tip) {
    if (keep('HEAD')) lines.push(`${tip} HEAD${symrefs ? ` symref-target:${headSymref(repo)}` : ''}\n`);
  } else if (unborn && keep('HEAD')) {
    lines.push(`unborn HEAD${symrefs ? ` symref-target:${headSymref(repo)}` : ''}\n`);
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    lines.push(`${ref.oid} ${ref.name}${peel && ref.peeled ? ` peeled:${ref.peeled}` : ''}\n`);
  }
  lines.push('flush');
  const built = pktLines(lines);
  if (repo.lsRefsCache.size >= LS_REFS_CACHE_MAX) repo.lsRefsCache.clear();
  repo.lsRefsCache.set(key, built);
  return built;
}

// ---------------------------------------------------------------------------------------------
// fetch (v2 and v0 share the negotiation)
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth: number | null;
}

interface FetchOutcome {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

function planFetch(repo: Repo, plan: FetchPlan): FetchOutcome {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const shallowSet = new Set(plan.shallowBoundaries);
  // What the client already holds: the haves' closure, not crossing shallow boundaries.
  const held = collectReachable(plan.haves, lookup, { stopAt: shallowSet, allowMissing: true });
  // What the wants need, bounded by depth.
  const wanted = collectReachable(plan.wants, lookup, { maxDepth: plan.depth ?? undefined, allowMissing: true });
  const send = new Set<string>();
  for (const oid of wanted) if (!held.has(oid)) send.add(oid);

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (plan.depth !== null) {
    // The new boundary: commits reached at exactly the depth limit that still have parents.
    const atLimit = new Set<string>();
    const queue: Array<{ oid: string; depth: number }> = plan.wants.map((oid) => ({ oid, depth: 1 }));
    const seen = new Set<string>();
    while (queue.length) {
      const { oid, depth } = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const peeled = peelToCommit(repo.objects, oid);
      const object = repo.objects.get(peeled);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      if (depth === plan.depth) {
        if (commit.parents.length > 0) atLimit.add(peeled);
        continue;
      }
      for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
    }
    for (const oid of atLimit) shallow.push(oid);
  }
  // Old boundaries whose parents are all now held or sent are no longer shallow.
  for (const boundary of plan.shallowBoundaries) {
    const object = repo.objects.get(boundary);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) continue;
    const complete = parents.every((p) => send.has(p) || held.has(p));
    const reachable = wanted.has(boundary) || held.has(boundary);
    if (complete && reachable) unshallow.push(boundary);
  }
  shallow.sort();
  unshallow.sort();

  const acks: string[] = [];
  for (const have of plan.haves) if (repo.objects.has(have)) acks.push(have);

  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return { pack: writePack(objects), shallow, unshallow, acks };
}

/**
 * The cache key for a fetch response. The response is determined by the wants as a
 * set (the sent objects are sorted), the haves in order (the ACK order), the shallow
 * boundaries as a set (unshallow lines are sorted), and the depth — plus the repo
 * state, which bumpGit captures by clearing the cache.
 */
function fetchCacheKey(protocol: string, plan: FetchPlan): string {
  return JSON.stringify([protocol, [...plan.wants].sort(), plan.haves, [...plan.shallowBoundaries].sort(), plan.depth]);
}

function fetchResponseV2(repo: Repo, plan: FetchPlan): Buffer {
  const key = fetchCacheKey('v2', plan);
  const cached = repo.fetchCache.get(key);
  if (cached) return cached;
  const outcome = planFetch(repo, plan);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (outcome.acks.length > 0) {
    for (const ack of outcome.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(Buffer.from('0001', 'ascii'));
  if (outcome.shallow.length > 0 || outcome.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of outcome.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of outcome.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  parts.push(pktLine('packfile\n'));
  for (const chunk of sidebandChunks(outcome.pack)) parts.push(chunk);
  parts.push(Buffer.from('0000', 'ascii'));
  const built = Buffer.concat(parts);
  if (repo.fetchCache.size >= FETCH_CACHE_MAX) repo.fetchCache.clear();
  repo.fetchCache.set(key, built);
  return built;
}

function fetchResponseV0(repo: Repo, plan: FetchPlan): Buffer {
  const key = fetchCacheKey('v0', plan);
  const cached = repo.fetchCache.get(key);
  if (cached) return cached;
  const outcome = planFetch(repo, plan);
  const parts: Buffer[] = [];
  for (const oid of outcome.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of outcome.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (outcome.acks.length > 0) {
    for (const ack of outcome.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const chunk of sidebandChunks(outcome.pack)) parts.push(chunk);
  parts.push(Buffer.from('0000', 'ascii'));
  const built = Buffer.concat(parts);
  if (repo.fetchCache.size >= FETCH_CACHE_MAX) repo.fetchCache.clear();
  repo.fetchCache.set(key, built);
  return built;
}

// ---------------------------------------------------------------------------------------------
// POST git-upload-pack
// ---------------------------------------------------------------------------------------------

function packetText(packet: Pkt): string | null {
  return packet.kind === 'data' ? packet.payload.toString('utf8') : null;
}

export function handleUploadPack(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  const first = packetText(packets[0]!);
  if (first !== null && first.startsWith('command=')) {
    // Protocol v2: command lines, a delim, then arguments, then a flush.
    const command = first.slice('command='.length).trim();
    const args: string[] = [];
    let pastDelim = false;
    for (const packet of packets.slice(1)) {
      if (packet.kind === 'delim') {
        pastDelim = true;
        continue;
      }
      if (packet.kind !== 'data') continue;
      if (pastDelim) args.push(packet.payload.toString('utf8').trim());
    }
    if (command === 'ls-refs') return handleLsRefs(repo, args);
    if (command === 'fetch') {
      const plan: FetchPlan = { wants: [], haves: [], shallowBoundaries: [], depth: null };
      for (const arg of args) {
        if (arg.startsWith('want ')) plan.wants.push(arg.slice(5).split(' ')[0]!);
        else if (arg.startsWith('have ')) plan.haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) plan.shallowBoundaries.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) {
          const n = Number(arg.slice(7).trim());
          if (Number.isFinite(n) && n > 0) plan.depth = Math.trunc(n);
        }
      }
      plan.wants = plan.wants.filter(isObjectId);
      return fetchResponseV2(repo, plan);
    }
    throw new Error(`unknown v2 command ${JSON.stringify(command)}`);
  }
  // Protocol v0: want/have/deepen lines across two flush-separated sections.
  const plan: FetchPlan = { wants: [], haves: [], shallowBoundaries: [], depth: null };
  for (const packet of packets) {
    const text = packetText(packet);
    if (text === null) continue;
    const line = text.trim();
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0]!;
      if (isObjectId(oid)) plan.wants.push(oid);
    } else if (line.startsWith('have ')) plan.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) plan.shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n) && n > 0) plan.depth = Math.trunc(n);
    }
  }
  if (plan.wants.length === 0) throw new Error('v0 fetch with no wants');
  return fetchResponseV0(repo, plan);
}

// ---------------------------------------------------------------------------------------------
// POST git-receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(forge: Forge, repo: Repo, body: Buffer): Buffer {
  const { packets, offset } = decodePktLines(body, true);
  const commands: PushCommand[] = [];
  let capabilities = '';
  let first = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    if (first) {
      first = false;
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        capabilities = text.slice(nul + 1);
        text = text.slice(0, nul);
      }
    }
    const line = text.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3 || !isObjectId(parts[0]!) || !isObjectId(parts[1]!)) {
      throw new Error('malformed receive-pack command');
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
  }
  if (commands.length === 0) throw new Error('receive-pack with no commands');

  // The pack follows the command list's flush. A delete-only push carries none.
  const packBytes = body.subarray(offset);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const useSideband = capabilities.split(' ').includes('side-band-64k');
  const report: string[] = [];
  if (unpackError !== null) {
    report.push(`unpack error ${unpackError}\n`);
    for (const command of commands) report.push(`ng ${command.ref} unpacker error\n`);
  } else {
    report.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      let reason: string | null = null;
      if (!command.ref.startsWith('refs/')) {
        reason = 'invalid ref';
      } else if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === ZERO_OID) reason = 'remote ref does not exist';
        else if (command.oldOid !== ZERO_OID && command.oldOid !== current) reason = 'old oid mismatch';
      } else {
        if (!repo.objects.has(command.newOid)) {
          reason = 'object not found';
        } else if (command.oldOid === ZERO_OID) {
          if (current !== ZERO_OID) reason = 'already exists';
        } else if (command.oldOid !== current) {
          reason = 'old oid mismatch';
        } else if (command.ref.startsWith('refs/heads/')) {
          const newCommit = peelToCommit(repo.objects, command.newOid);
          const oldCommit = peelToCommit(repo.objects, command.oldOid);
          if (!forge.isAncestor(repo, newCommit, oldCommit)) reason = 'non-fast-forward';
        }
      }
      if (reason !== null) {
        report.push(`ng ${command.ref} ${reason}\n`);
      } else {
        if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
        else repo.refs.set(command.ref, command.newOid);
        report.push(`ok ${command.ref}\n`);
      }
    }
  }

  // Objects and/or refs may have moved: drop the memoized wire answers.
  forge.bumpGit(repo);

  const inner = pktLines([...report, 'flush']);
  if (!useSideband) return inner;
  const outer: Buffer[] = [];
  for (let at = 0; at < inner.length; at += 65515) {
    outer.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(at, at + 65515)])));
  }
  outer.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(outer);
}

/** Parse an annotated tag's target for advertisement peeling (re-exported helper). */
export function tagTarget(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  return parseTag(object.data).object;
}
