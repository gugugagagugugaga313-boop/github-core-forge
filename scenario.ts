// The suite's seeded identity, re-derived locally: the forge cannot learn the token
// owner's login from the opaque bearer token, so it recomputes the scenario's users
// from the same fixed seed the suite uses. This is the xorshift64* generator and the
// name tables, ported from the kit's wire contract, used only to name the viewer,
// the teammate, the stranger and the org. No wall clock, no randomness.

const SEED = 0x6a09e667f3bcc909n;
const MASK64 = 0xffffffffffffffffn;

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];
const REPO_ADJECTIVES: readonly string[] = [
  'amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively',
  'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat',
  'vivid', 'warm', 'witty', 'young', 'zesty',
];
const REPO_NOUNS: readonly string[] = [
  'acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor',
  'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven',
  'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
];

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & MASK64;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

/** Deterministic 64-bit stream: xorshift64* with splitmix64-style seeding per label. */
export class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & MASK64;
    this.#state = masked === 0n ? SEED : masked;
  }

  static fromLabel(label: string): Rng {
    return new Rng(mix64(SEED ^ fnv1a64(label)));
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & MASK64;
    x = (x ^ (x << 25n)) & MASK64;
    x = (x ^ (x >> 27n)) & MASK64;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & MASK64;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)]!;
  }
}

export interface ScenarioIdentity {
  readonly login: string;
  readonly name: string;
  readonly email: string;
  readonly id: number;
}

export interface ForgeIdentity {
  readonly viewer: ScenarioIdentity;
  readonly teammate: ScenarioIdentity;
  readonly stranger: ScenarioIdentity;
  readonly org: string;
}

function generateUsers(rng: Rng, count: number): ScenarioIdentity[] {
  const used = new Set<string>();
  const users: ScenarioIdentity[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

/** The forge's identity, derived once at startup. Never changes during a run. */
export function deriveIdentity(): ForgeIdentity {
  const users = generateUsers(Rng.fromLabel('users'), 12);
  const orgRng = Rng.fromLabel('org');
  const org = `${orgRng.pick(REPO_ADJECTIVES)}-${orgRng.pick(REPO_NOUNS)}-org`;
  return {
    viewer: users[0]!,
    teammate: users[1]!,
    stranger: users[2]!,
    org,
  };
}
