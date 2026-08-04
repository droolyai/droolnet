# ICEFAM.FM local-first social network architecture

Status: implementation roadmap plus verified local-first social core. The current subset includes social CRDT materialization, signed encrypted change DAGs, root-signed device delegation, X25519 space-key wrapping, verified in-memory storage, encrypted snapshots, an authenticated carrier-agnostic replication protocol, and an ICEFAM browser IndexedDB draft node. It is not a claim that an internet P2P network, E2EE DMs, Seeker node fleet, or reward contract is deployed.

## Product boundary

ICEFAM.FM is the social music application: profiles, posts, feeds, follows, reactions, communities, DMs, channels, music/video releases, provenance, memberships, tips, and creator storefronts. WOKE.NET is the chain-independent transport, encrypted object, local storage, sync, discovery, continuity, and verifiable-ranking layer. Solana is the phase-one identity/payment/reward adapter, not the owner of the social graph.

## Clean-room reference analysis

Any-Sync demonstrates the right separation: encrypted user-owned spaces; signed change DAGs; local-first operation; replaceable sync providers; distinct sync, file, consensus/ACL, and coordinator roles. Its protocol repository is MIT. Anytype Heart and the desktop client use the Any Source Available License, so ICEFAM must not copy their protected application/middleware code without a separate license review. We implement our own social schema and protocol.

Also, do not assume Any-Sync is simply “libp2p + IPFS.” Its current public architecture describes its own nodes and encrypted DAG protocol. WOKE.NET may choose libp2p after a transport spike, but that is our design decision, not an Anytype compatibility claim.

## Social object model

Every durable entity is a typed object. Every mutation is an authenticated operation in a change DAG.

| Object | Public space | Private space | Merge rule |
| --- | --- | --- | --- |
| Profile | opt-in | drafts/device settings | field registers + key history |
| Post/thread | opt-in | drafts, circles, DMs | ordered block sequence + tombstones |
| Follow | opt-in or private | private graph supported | observed add/remove set |
| Reaction | opt-in | private bookmark/reaction | observed add/remove set |
| Media manifest | opt-in metadata | encrypted source/master | immutable content-addressed versions |
| Community | discoverable metadata | membership/roles | signed ACL log + epochs |
| DM/channel | no | E2EE space | ordered message DAG + deletion tombstones |
| Moderation label | scoped | personal/community policy | signed append-only attestations |
| Feed preference | no by default | local device space | local registers and sets |
| Node receipt | aggregate proof only | raw service evidence | signed epoch receipt |

Public publishing is not the same as E2EE sync. A creator explicitly exports a signed object from a private/local space into a public replication space. Search/index relays can read public objects, never private ciphertext.

## Protocol stack

1. Identity: device Ed25519 key; account root delegates short-lived device keys. Solana wallet linkage is an optional signed attestation, not the encryption root.
2. Spaces and keys: random 256-bit space keys. X25519/HPKE member envelopes, key epochs, removal-triggered rotation, device revocation, recovery quorum, and hardware-backed storage are required before production.
3. Change DAG: canonical binary or deterministic encoding, SHA-256/BLAKE3 content IDs, Ed25519 signatures, explicit parents, bounded changes, replay protection, and snapshot ancestry.
4. CRDTs: registers, observed-remove sets/maps, ordered sequences, counters only where necessary. Never use one global last-write-wins record for a profile or post.
5. Local store: encrypted SQLite on mobile/desktop, IndexedDB for the web beta, content-addressed encrypted blobs, transactional head updates, quota/eviction policy, export/import.
6. Sync: the implemented research subset exchanges bounded inventories, requests missing changes, verifies every encrypted change before storage, rejects incomplete ancestry, and converges concurrent branches. Compact summaries, blob exchange, flow-control backpressure, and production fanout policy remain pending.
7. Transport: the implemented carrier-agnostic core mutually authenticates Ed25519 peers with a transcript-bound challenge/ack, rejects stale/replayed handshakes, signs monotonic session frames, and isolates spaces. LAN discovery, QUIC/WebTransport or libp2p/Noise carriers, NAT traversal, circuit relays, and optional DHT/rendezvous remain pending. Web browsers require relay/signaling fallbacks and cannot promise universal direct P2P.
8. Public layer: permissionless public relays, replaceable indexers, signed moderation labels, transparent feed receipts, creator-controlled mirrors, and portable exports.
9. Continuity: snapshots, erasure-coded encrypted media shards, multiple independent providers, restore drills, and published availability measurements.

## Seeker peer plan

Seeker is an Android device, so an ICEFAM native app can run a foreground or user-approved scheduled peer service. It cannot safely promise 24/7 background service: Android power, data, thermal, and background-execution limits apply.

Use Mobile Wallet Adapter for wallet authorization and signatures; do not access Seed Vault secrets. A Seeker Genesis Token may be an optional device-ownership signal, never proof that useful network work occurred.

Node roles:

- edge cache: encrypted public media chunks, opt-in and storage-capped;
- private sync peer: only a user’s own authorized spaces;
- relay assistant: bounded rendezvous/relay work while foregrounded, never an open proxy;
- inference contributor: future, opt-in, sandboxed, metered, model-license compliant;
- witness: signs availability challenges and receipt observations without seeing private content.

Proof-of-service must measure useful work, not battery drain: challenge/response availability, chunk integrity, unique peer delivery, latency bands, and independent witness quorum. Cap by epoch, use diminishing returns, detect collusion, exclude self-traffic, permit appeals, and publish the scoring function.

## DROOLY Points and proposed future token distribution

DROOLY Points are non-transferable, have no cash value, and are not presently redeemable. Node participation may earn provisional points only after the service proof system, terms, privacy disclosures, abuse controls, tax/securities review, and independent audit exist.

The founder-proposed 4-year-20-day `$DROOLY` distribution must remain a proposal until the referenced Streamflow unlock is independently verified at the relevant time and a separate audited claim program publishes: exact eligible epochs, pool size, conversion formula, caps, jurisdiction rules, sybil policy, claim window, dust handling, unclaimed allocation, emergency behavior, and immutable program IDs. Never promise an automatic airdrop or fixed conversion before those facts exist.

## Production gates

- independent cryptography and protocol audit;
- reproducible mobile builds and signed releases;
- threat model covering XSS, device theft, malicious peers, metadata leakage, spam, eclipse/Sybil attacks, rollback, nonce reuse, compromised relays, and recovery abuse;
- two-device offline/concurrent convergence tests and network partitions;
- key rotation/revocation/recovery tests;
- NAT matrix and relay load tests;
- battery/data/thermal budgets on real Android devices;
- content safety, copyright, abuse reporting, and law-enforcement policy without decryption backdoors;
- reward-economic simulation and legal/tax review;
- public status page with honest node, relay, and audit state.
