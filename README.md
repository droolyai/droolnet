# WokeNet

**The sovereign network. The protocol that powers WokeSocial ($WOKE).**

WokeNet is the long-horizon protocol program of
[Decentralized Sovereignty](docs/DECENTRALIZED_SOVEREIGNTY.md): decentralized
core infrastructure, complete user sovereignty, and planetary-scale
coordination — built gate by gate, with every claim measured before it is
made.

> **Status: research and foundation repository.** The WokeSocial product and
> its current Solana protocol deployment live in the sibling
> [`wokesocial`](https://github.com/AlexBTC420/wokesocial) repository and are
> unaffected by work here. Nothing in this repository is deployed. A claim
> becomes true here the same way it does there: implementation, tests, and a
> reproducible result.

## What lives here

| Area | Contents | Status |
| --- | --- | --- |
| [`packages/middle-out`](packages/middle-out) | The middle-out compression program: content-defined chunking with global dedup, and typed middle-representation transcoding for protocol data — self-verifying losslessness, deterministic corpus, reproducible benchmarks | Implemented subset with measured results in `packages/middle-out/BENCHMARK.md` |
| [`packages/feed`](packages/feed) | Deterministic, user-owned feed ranking: local policy, fixed integer weights, author diversity, and cryptographic input/preference/output receipts | Implemented research subset; not connected to a production relay or index |
| [`packages/sync-core`](packages/sync-core) | Signed, encrypted, content-addressed change-DAG primitives for ICEFAM.FM social spaces | Implemented cryptographic subset; discovery, storage adapters, key rotation, and production E2EE are staged |
| [`packages/carrier-mesh`](packages/carrier-mesh) | A license-clean transport carrier that drives sync-core's authenticated handshake and anti-entropy replication over any injected duplex peer channel | Implemented subset: authenticated frame carrier + anti-entropy replication over an injected duplex transport, verified in a 2-node in-memory loopback test. No production wire carrier (WebRTC/libp2p/WebTransport), discovery, relay, or transport-layer encryption; the real WebRTC-mesh adapter is external (drooly-web) and not included here |
| [`docs/MIDDLE_OUT.md`](docs/MIDDLE_OUT.md) | The compression program's definition, measurement contract, and roadmap | Design + implemented subset |
| [`docs/VIDEO.md`](docs/VIDEO.md) | The decentralized video platform design — fast, high-quality, environment-friendly, free, accepting, with honest safety boundaries | Design; not built |
| [`docs/DECENTRALIZED_SOVEREIGNTY.md`](docs/DECENTRALIZED_SOVEREIGNTY.md) | The founding ideology: the Pillars of Decentralization | Owner vision |
| [`docs/DECISIONS/`](docs/DECISIONS) | Architecture decision records for this repository | Active |

The sovereign chain itself — consensus, execution, state — is designed in the
open here before any implementation claim is made. Until its gates pass,
WokeSocial ships on its current rails; this repository is where those rails
are eventually replaced.

## Quick start

Requires Node `22.23.1` and pnpm `11.2.2` (Corepack).

```sh
pnpm install
pnpm verify        # format, lint, typecheck, tests, build
pnpm bench         # reproduce the middle-out measurements
```

## Discipline

This repository inherits the evidence culture of its sibling: nothing is
described as shipped until it is implemented and verified, no efficiency claim
ships without a public corpus and a reproducible score, and losslessness is
enforced structurally (encode-time self-verification with a passthrough
fallback), not hoped for.

## License

**Source-available dual license — not OSI open source.**

| Track | Rights | Cost |
| --- | --- | --- |
| **Section A** | Read, audit, test, benchmark, non-commercial evaluation, security research | Free |
| **Section B** | Production, SaaS, commercial redistribution, government operational use | **Paid** |

- Full legal text: [`LICENSE`](LICENSE)
- How to buy production rights: [`COMMERCIAL_LICENSE.md`](COMMERCIAL_LICENSE.md)
- Short banner: [`NOTICE`](NOTICE)

Transparency and validation are free. Production and government operational use
require a written Section B license. Historical MIT snapshots remain under MIT
for recipients who obtained them while MIT applied; **current default-branch
code is dual-licensed.**

By contributing, you accept the CLA terms in [`LICENSE`](LICENSE).
