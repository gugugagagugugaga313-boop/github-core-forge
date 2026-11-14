# github-core-forge

A GitHub-compatible git forge in a single dependency-free Node process. It speaks
the smart-HTTP git protocol (upload-pack v0/v2, receive-pack v0), the REST v3
API, the GraphQL v4 API, and MCP — all over one in-memory store, so a repository
created through any surface is visible through the others.

## Run

```sh
node --experimental-strip-types main.ts
```

Listens on `PORT` (default 3000) when `MAKEFUN_ENV_URL` is unset. With
`MAKEFUN_ENV_URL` set, the process binds an ephemeral port, registers it with
the environment, and exits when the trial ends.

## Layout

- `main.ts` — process entry point and environment lifecycle.
- `app.ts` — HTTP routing, authentication gate, response envelope.
- `store.ts` — the in-memory forge: repositories, git objects, issues, pulls.
- `gitobj.ts` — git object model: hashing, trees, commits, pack reading/writing,
  pkt-line framing.
- `githttp.ts` — smart-HTTP advertisements, ls-refs, fetch planning, receive-pack.
- `rest.ts` — REST v3 handlers and views.
- `graphql.ts` — GraphQL parser and executor, including introspection.
- `mcp.ts` — MCP JSON-RPC endpoint and its six tools.
- `scenario.ts` — deterministic identity derivation for the trial scenario.
- `ids.ts` — opaque GraphQL global ids.

## Notes

- State is in-memory only; restarting the process starts from an empty forge.
- Every request needs a non-empty `Authorization: Bearer` token except
  `GET /healthz`. A repository owned by anyone else answers 404, never 403.
- API timestamps come from `MAKEFUN_TRIAL_NOW` when set, so responses stay
  deterministic across replays.
