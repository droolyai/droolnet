# AGENTS.md — wokenet

Guidance for AI agents working in **wokenet** only.

## What this is

**Research and foundation** repository for the WokeNet / decentralized sovereignty program:

- Middle-out compression package (`packages/middle-out`) with measured benchmarks
- Design docs: middle-out, video platform, decentralized sovereignty thesis
- **Not** the deployed WetDrool/WokeSocial product monorepo

> A claim becomes true here only with implementation, tests, and reproducible results. Nothing here is “mainnet live” by virtue of docs alone.

## Stack (typical)

- pnpm workspace + Turbo
- TypeScript packages under `packages/`
- Node version pins via `.nvmrc` / `.node-version`

Use the repo’s `package.json` scripts (`pnpm test`, package-level benches) rather than inventing a second toolchain.

## Agent rules

1. **Honest status:** research / foundation. Do not imply production deployment of WokeNet as a chain or social app from this tree alone.
2. Product Solana social work lives primarily in **`wetdrool-web`** (and any sibling wokesocial history) — don’t merge product and research claims.
3. Prefer measured benchmarks and existing docs contracts (`docs/MIDDLE_OUT.md`, `BENCHMARK.md`) when changing compression behavior.
4. Dual license / commercial notes: respect `LICENSE`, `COMMERCIAL_LICENSE.md`, `NOTICE`.
5. Keep PRs scoped; don’t “rebrand everything to Icefam” here.

## Related

- `../wetdrool-web` — consumer product monorepo
- Parent: `../../AGENTS.md`
