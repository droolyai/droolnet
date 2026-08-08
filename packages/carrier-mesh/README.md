# @wokenet/carrier-mesh

A license-clean transport **carrier** that drives `@wokenet/sync-core`'s
authenticated replication protocol over any injected duplex peer channel.

sync-core already implements the hard part: the transcript-bound Ed25519
handshake (`PeerHello`/`PeerChallenge`/`PeerAck` → `AuthenticatedPeerSession`),
signed monotonic `SignedTransportFrame`s, and bounded inventory/want/change
payloads. What was missing was something to actually *move* those frames between
two nodes. This package is that mover — and nothing more.

## The port (dependency-inversion boundary)

droolnet OWNS this interface. A carrier speaks it and never anything more
specific, so a real transport (WebRTC data channel, libp2p stream, WebSocket)
becomes an EXTERNAL adapter implemented from its own repository. No drooly-web
mesh is imported or copied here.

```ts
interface DuplexPeerChannel {
  readonly localPeerId: string;
  send(peerId: string, bytes: Uint8Array): void;
  onMessage(handler: (from: string, bytes: Uint8Array) => void): void;
  peers(): readonly string[];
  close(): void;
}
```

The port carries opaque bytes — an already-serialized frame — exactly like a
real data channel would. It holds no protocol semantics.

## The carrier

`Carrier` drives the flow over any `DuplexPeerChannel`:

1. Runs the authenticated handshake to establish an `AuthenticatedPeerSession`.
2. Runs anti-entropy replication: send inventory → receive want → send changes,
   symmetric in both directions.
3. Verifies **every** inbound `SignedTransportFrame` with sync-core's own
   validators (`PeerFrameReceiver` / `verifyTransportFrame`) before the payload
   is trusted. All signing and verification is delegated to sync-core; none is
   reimplemented here. Rejected handshakes and frames are routed to `onError`
   rather than crashing the node.

## Measured status

- **Implemented and verified:** an authenticated frame carrier plus anti-entropy
  replication over an injected duplex transport, proven by a 2-node in-memory
  loopback test (`test/carrier-mesh.test.ts`). Two sync-core nodes complete the
  mutual handshake and replicate encrypted changes end-to-end: node B ends up
  with a change it did not author, cryptographically re-verified, and both nodes
  converge to identical receipts (change count + heads + root). Adversarial
  cases assert that a tampered frame (`payload_tampered`), a wrong-session frame
  (`session_mismatch`), and a wrong-space handshake (`wrong_space`) are all
  rejected before any storage.

- **NOT included here:** no production wire carrier (WebRTC / libp2p / WebTransport),
  no peer discovery, no relay/NAT traversal, and no transport-layer encryption.
  The in-memory channel pair is a test harness, not a network. The real
  WebRTC-mesh adapter lives EXTERNALLY in drooly-web (MIT) and is deliberately
  kept out of this source-available repository; wiring it up is a separate later
  slice.
