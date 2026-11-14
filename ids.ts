// Relay-style global ids: opaque, stable, and decodable. The encoding is base64 of a
// typed path, so node(id:) and the mutations can resolve an id back to its object
// without a lookup table. Never equal to a plain database id or issue number.

export function repoGlobalId(owner: string, name: string): string {
  return Buffer.from(`R:${owner}/${name}`, 'utf8').toString('base64');
}

export function issueGlobalId(owner: string, name: string, number: number): string {
  return Buffer.from(`I:${owner}/${name}:${number}`, 'utf8').toString('base64');
}

export function pullGlobalId(owner: string, name: string, number: number): string {
  return Buffer.from(`P:${owner}/${name}:${number}`, 'utf8').toString('base64');
}

export function commentGlobalId(owner: string, name: string, number: number, commentId: number): string {
  return Buffer.from(`C:${owner}/${name}:${number}:${commentId}`, 'utf8').toString('base64');
}

export type DecodedGlobalId =
  | { kind: 'repo'; owner: string; name: string }
  | { kind: 'issue'; owner: string; name: string; number: number }
  | { kind: 'pull'; owner: string; name: string; number: number }
  | { kind: 'comment'; owner: string; name: string; number: number; commentId: number };

export function decodeGlobalId(id: string): DecodedGlobalId | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const repoMatch = /^R:([^/]+)\/(.+)$/.exec(text);
  if (repoMatch) return { kind: 'repo', owner: repoMatch[1]!, name: repoMatch[2]! };
  const issueMatch = /^I:([^/]+)\/(.+):(\d+)$/.exec(text);
  if (issueMatch) return { kind: 'issue', owner: issueMatch[1]!, name: issueMatch[2]!, number: Number(issueMatch[3]) };
  const pullMatch = /^P:([^/]+)\/(.+):(\d+)$/.exec(text);
  if (pullMatch) return { kind: 'pull', owner: pullMatch[1]!, name: pullMatch[2]!, number: Number(pullMatch[3]) };
  const commentMatch = /^C:([^/]+)\/(.+):(\d+):(\d+)$/.exec(text);
  if (commentMatch) {
    return { kind: 'comment', owner: commentMatch[1]!, name: commentMatch[2]!, number: Number(commentMatch[3]), commentId: Number(commentMatch[4]) };
  }
  return null;
}
