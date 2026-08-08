/**
 * Transport PORT — the license-clean dependency-inversion boundary.
 *
 * droolnet/wokenet OWNS this interface. A carrier drives sync-core's protocol
 * over ANY object that satisfies `DuplexPeerChannel`. No real mesh, WebRTC, or
 * MIT-licensed drooly-web transport is imported here: those become EXTERNAL
 * adapters that implement this port from their own repositories.
 *
 * The port speaks raw bytes (an already-serialized frame), exactly like a real
 * WebRTC data channel or libp2p stream would. It carries no protocol semantics.
 */
export interface DuplexPeerChannel {
  /** Stable identifier of the local endpoint (a `wokeid:v1:...` peer id). */
  readonly localPeerId: string;
  /** Deliver an opaque, already-serialized message to a connected peer. */
  send(peerId: string, bytes: Uint8Array): void;
  /** Register a handler invoked for every inbound message from a peer. */
  onMessage(handler: (from: string, bytes: Uint8Array) => void): void;
  /** Currently reachable peer ids. */
  peers(): readonly string[];
  /** Detach handlers and refuse further traffic. */
  close(): void;
}

export class ChannelError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelError';
  }
}

/**
 * A cross-wired pair of in-memory channels used to prove the carrier without a
 * browser or network. Delivery is asynchronous and FIFO: each `send` enqueues
 * a microtask, modelling a real duplex link where the remote handler never runs
 * re-entrantly inside the caller's `send`. `idle()` resolves once no message is
 * in flight, giving tests a deterministic quiescence point.
 */
export interface InMemoryChannelPair {
  readonly a: DuplexPeerChannel;
  readonly b: DuplexPeerChannel;
  /** Resolves when every enqueued message (including cascades) has been delivered. */
  idle(): Promise<void>;
}

class InMemoryBus {
  #inFlight = 0;
  #idleWaiters: (() => void)[] = [];

  enqueue(deliver: () => void): void {
    this.#inFlight += 1;
    queueMicrotask(() => {
      try {
        deliver();
      } finally {
        this.#inFlight -= 1;
        if (this.#inFlight === 0) {
          const waiters = this.#idleWaiters;
          this.#idleWaiters = [];
          for (const resolve of waiters) resolve();
        }
      }
    });
  }

  idle(): Promise<void> {
    if (this.#inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }
}

class InMemoryDuplexChannel implements DuplexPeerChannel {
  readonly #handlers: ((from: string, bytes: Uint8Array) => void)[] = [];
  readonly #bus: InMemoryBus;
  #remote: InMemoryDuplexChannel | null = null;
  #closed = false;

  constructor(
    readonly localPeerId: string,
    bus: InMemoryBus,
  ) {
    this.#bus = bus;
  }

  link(remote: InMemoryDuplexChannel): void {
    this.#remote = remote;
  }

  send(peerId: string, bytes: Uint8Array): void {
    if (this.#closed) throw new ChannelError('channel_closed', 'Channel is closed.');
    const remote = this.#remote;
    if (!remote || peerId !== remote.localPeerId) {
      throw new ChannelError('unknown_peer', 'Peer is not connected to this channel.');
    }
    // Defensive copy: model a wire that owns its own buffer once handed off.
    const copy = bytes.slice();
    this.#bus.enqueue(() => remote.deliver(this.localPeerId, copy));
  }

  deliver(from: string, bytes: Uint8Array): void {
    if (this.#closed) return;
    for (const handler of [...this.#handlers]) handler(from, bytes);
  }

  onMessage(handler: (from: string, bytes: Uint8Array) => void): void {
    this.#handlers.push(handler);
  }

  peers(): readonly string[] {
    const remote = this.#remote;
    return remote && !this.#closed ? Object.freeze([remote.localPeerId]) : Object.freeze([]);
  }

  close(): void {
    this.#closed = true;
    this.#handlers.length = 0;
  }
}

export function createInMemoryChannelPair(peerIdA: string, peerIdB: string): InMemoryChannelPair {
  if (peerIdA === peerIdB) {
    throw new ChannelError('self_link', 'A channel pair needs two distinct peer ids.');
  }
  const bus = new InMemoryBus();
  const a = new InMemoryDuplexChannel(peerIdA, bus);
  const b = new InMemoryDuplexChannel(peerIdB, bus);
  a.link(b);
  b.link(a);
  return Object.freeze({ a, b, idle: () => bus.idle() });
}
