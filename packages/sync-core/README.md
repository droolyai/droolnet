# @wokenet/sync-core

Clean-room protocol primitives for encrypted ICEFAM/WOKE local-first social spaces.

Implemented now: Ed25519 self-certifying device identities, root-signed bounded device delegation, X25519/HKDF/AES-GCM space-key wrapping, AES-256-GCM encrypted changes, signed content-addressed change DAGs, deterministic topological ordering, social CRDT materialization, in-memory verified storage, encrypted store snapshots, and a carrier-agnostic authenticated replication protocol.

The replication protocol provides transcript-bound mutual Ed25519 authentication, fresh nonces, replay windows, signed monotonic frames, bounded inventory/want/change batches, space isolation, verification before storage, and deterministic convergence tests. Import it from `@wokenet/sync-core/transport`.

A carrier that drives this protocol over an injected duplex channel is implemented in [`@wokenet/carrier-mesh`](../carrier-mesh) and verified in a 2-node in-memory loopback test.

This is not yet an internet P2P network. The protocol does not yet have a production libp2p/Noise or WebTransport wire carrier, and the loopback carrier provides no transport-layer encryption. Peer discovery, relay/DHT routing, NAT traversal, platform IndexedDB/SQLite adapters, distributed revocation, recovery, richer ordered-sequence CRDTs, snapshots with compaction policy, and an external security audit remain required before production E2EE messaging claims.

Any-Sync is an architectural reference only. No Anytype client or Anytype Heart source is copied.
