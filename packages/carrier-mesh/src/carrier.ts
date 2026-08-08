import { canonicalize, type DeviceIdentity } from '@wokenet/sync-core';
import type { MemoryChangeStore } from '@wokenet/sync-core/storage';
import {
  acceptPeerChallenge,
  acceptPeerHello,
  applyChangesPayload,
  changesPayload,
  createPeerHello,
  createTransportFrame,
  finalizePeerHandshake,
  HandshakeReplayWindow,
  inventoryPayload,
  PeerFrameReceiver,
  type AuthenticatedPeerSession,
  type PeerAck,
  type PeerChallenge,
  type PeerHello,
  type SignedTransportFrame,
  type TransportPayload,
  wantedPayload,
} from '@wokenet/sync-core/transport';
import type { DuplexPeerChannel } from './channel.js';

/**
 * Wire messages the carrier exchanges over a `DuplexPeerChannel`. The port owns
 * this envelope; sync-core's crypto owns everything inside it. Handshake
 * messages (`hello`/`challenge`/`ack`) and `SignedTransportFrame`s are all
 * plain, JSON-safe values, so the codec is a canonical-JSON encode/decode.
 */
export type CarrierMessage =
  | Readonly<{ t: 'hello'; hello: PeerHello }>
  | Readonly<{ t: 'challenge'; challenge: PeerChallenge }>
  | Readonly<{ t: 'ack'; ack: PeerAck }>
  | Readonly<{ t: 'frame'; frame: SignedTransportFrame }>;

const CARRIER_MESSAGE_KINDS = new Set(['hello', 'challenge', 'ack', 'frame']);

export class CarrierError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CarrierError';
  }
}

export function serializeCarrierMessage(message: CarrierMessage): Uint8Array {
  return new TextEncoder().encode(canonicalize(message));
}

export function deserializeCarrierMessage(bytes: Uint8Array): CarrierMessage {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CarrierError('invalid_message', 'Carrier message is not valid JSON.');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as { t?: unknown }).t !== 'string' ||
    !CARRIER_MESSAGE_KINDS.has((value as { t: string }).t)
  ) {
    throw new CarrierError('invalid_message', 'Unrecognized carrier message envelope.');
  }
  return value as CarrierMessage;
}

export interface CarrierEvents {
  /** Fired once a mutually authenticated session is established with a peer. */
  onSession?: (session: AuthenticatedPeerSession, remotePeerId: string) => void;
  /** Fired after a verified change batch is applied to the local store. */
  onReplicated?: (info: { remotePeerId: string; applied: number }) => void;
  /** Fired for any rejected handshake, tampered frame, or wrong-session frame. */
  onError?: (error: unknown, remotePeerId: string | null) => void;
}

export interface CarrierOptions extends CarrierEvents {
  identity: DeviceIdentity;
  spaceId: string;
  store: MemoryChangeStore;
  channel: DuplexPeerChannel;
  /** Automatically send an inventory once a session is established. Default true. */
  autoReplicate?: boolean;
  /** Clock source for handshake freshness. Default `() => new Date()`. */
  now?: () => Date;
}

interface PeerLink {
  readonly remotePeerId: string;
  readonly replayWindow: HandshakeReplayWindow;
  hello: PeerHello | null;
  challenge: PeerChallenge | null;
  session: AuthenticatedPeerSession | null;
  receiver: PeerFrameReceiver | null;
  txSequence: number;
}

/**
 * Drives sync-core's authenticated handshake and anti-entropy replication over
 * an injected `DuplexPeerChannel`. All signing/verification is delegated to
 * sync-core; the carrier only chooses *when* to call it and *what* to send. It
 * verifies every inbound frame (via `PeerFrameReceiver`) before touching the
 * store, and routes every rejection to `onError` instead of crashing.
 */
export class Carrier {
  readonly #identity: DeviceIdentity;
  readonly #spaceId: string;
  readonly #store: MemoryChangeStore;
  readonly #channel: DuplexPeerChannel;
  readonly #autoReplicate: boolean;
  readonly #now: () => Date;
  readonly #events: CarrierEvents;
  readonly #links = new Map<string, PeerLink>();

  constructor(options: CarrierOptions) {
    this.#identity = options.identity;
    this.#spaceId = options.spaceId;
    this.#store = options.store;
    this.#channel = options.channel;
    this.#autoReplicate = options.autoReplicate ?? true;
    this.#now = options.now ?? ((): Date => new Date());
    this.#events = options;
    this.#channel.onMessage((from, bytes) => this.#handleBytes(from, bytes));
  }

  get peerId(): string {
    return this.#identity.id;
  }

  /** Initiator side: open a session with a remote peer. */
  connect(remotePeerId: string): void {
    const link = this.#link(remotePeerId);
    const hello = createPeerHello({
      identity: this.#identity,
      spaceId: this.#spaceId,
      createdAt: this.#now().toISOString(),
    });
    link.hello = hello;
    this.#send(remotePeerId, { t: 'hello', hello });
  }

  /** Send a fresh inventory, starting an anti-entropy round. Requires a session. */
  requestSync(remotePeerId: string): void {
    const link = this.#links.get(remotePeerId);
    if (!link?.session) {
      this.#fail(remotePeerId, new CarrierError('no_session', 'No session for this peer yet.'));
      return;
    }
    this.#sendFrame(link, inventoryPayload(this.#store));
  }

  session(remotePeerId: string): AuthenticatedPeerSession | undefined {
    return this.#links.get(remotePeerId)?.session ?? undefined;
  }

  close(): void {
    this.#channel.close();
    this.#links.clear();
  }

  #link(remotePeerId: string): PeerLink {
    let link = this.#links.get(remotePeerId);
    if (!link) {
      link = {
        remotePeerId,
        replayWindow: new HandshakeReplayWindow(),
        hello: null,
        challenge: null,
        session: null,
        receiver: null,
        txSequence: 0,
      };
      this.#links.set(remotePeerId, link);
    }
    return link;
  }

  #handleBytes(from: string, bytes: Uint8Array): void {
    try {
      const message = deserializeCarrierMessage(bytes);
      switch (message.t) {
        case 'hello':
          this.#onHello(from, message.hello);
          break;
        case 'challenge':
          this.#onChallenge(from, message.challenge);
          break;
        case 'ack':
          this.#onAck(from, message.ack);
          break;
        case 'frame':
          this.#onFrame(from, message.frame);
          break;
      }
    } catch (error) {
      this.#fail(from, error);
    }
  }

  // Responder: hello -> challenge.
  #onHello(from: string, hello: PeerHello): void {
    if (hello.peerId !== from) {
      throw new CarrierError('peer_mismatch', 'Hello peer id does not match its sender.');
    }
    const link = this.#link(from);
    link.hello = hello;
    const challenge = acceptPeerHello({
      hello,
      responder: this.#identity,
      expectedSpaceId: this.#spaceId,
      replayWindow: link.replayWindow,
      now: this.#now(),
    });
    link.challenge = challenge;
    this.#send(from, { t: 'challenge', challenge });
  }

  // Initiator: challenge -> ack, session established.
  #onChallenge(from: string, challenge: PeerChallenge): void {
    const link = this.#links.get(from);
    if (!link?.hello) {
      throw new CarrierError('unexpected_challenge', 'No pending hello for this challenge.');
    }
    const { ack, session } = acceptPeerChallenge({
      hello: link.hello,
      challenge,
      initiator: this.#identity,
      replayWindow: link.replayWindow,
      now: this.#now(),
    });
    this.#establish(link, session, session.responderPeerId);
    this.#send(from, { t: 'ack', ack });
    this.#afterEstablish(link);
  }

  // Responder: ack finalizes and establishes the session.
  #onAck(from: string, ack: PeerAck): void {
    const link = this.#links.get(from);
    if (!link?.hello || !link.challenge) {
      throw new CarrierError('unexpected_ack', 'No pending handshake for this ack.');
    }
    const session = finalizePeerHandshake({
      hello: link.hello,
      challenge: link.challenge,
      ack,
      responder: this.#identity,
      now: this.#now(),
    });
    this.#establish(link, session, session.initiatorPeerId);
    this.#afterEstablish(link);
  }

  #establish(link: PeerLink, session: AuthenticatedPeerSession, remotePeerId: string): void {
    link.session = session;
    link.receiver = new PeerFrameReceiver(session, remotePeerId);
    this.#events.onSession?.(session, link.remotePeerId);
  }

  #afterEstablish(link: PeerLink): void {
    if (this.#autoReplicate) this.#sendFrame(link, inventoryPayload(this.#store));
  }

  #onFrame(from: string, frame: SignedTransportFrame): void {
    const link = this.#links.get(from);
    if (!link?.session || !link.receiver) {
      throw new CarrierError('no_session', 'Received a frame before a session existed.');
    }
    // Verifies protocol, session binding, sender, monotonic sequence, payload
    // hash, and Ed25519 signature BEFORE the payload is trusted.
    const payload = link.receiver.accept(frame);
    this.#applyPayload(link, payload);
  }

  #applyPayload(link: PeerLink, payload: TransportPayload): void {
    switch (payload.kind) {
      case 'inventory':
        this.#sendFrame(link, wantedPayload(this.#store, payload));
        break;
      case 'want':
        this.#sendFrame(link, changesPayload(this.#store, payload));
        break;
      case 'changes': {
        const applied = applyChangesPayload(this.#store, payload);
        this.#events.onReplicated?.({ remotePeerId: link.remotePeerId, applied });
        break;
      }
    }
  }

  #sendFrame(link: PeerLink, payload: TransportPayload): void {
    if (!link.session) {
      throw new CarrierError('no_session', 'Cannot send a frame without a session.');
    }
    const frame = createTransportFrame({
      session: link.session,
      identity: this.#identity,
      sequence: link.txSequence,
      payload,
    });
    link.txSequence += 1;
    this.#send(link.remotePeerId, { t: 'frame', frame });
  }

  #send(remotePeerId: string, message: CarrierMessage): void {
    this.#channel.send(remotePeerId, serializeCarrierMessage(message));
  }

  #fail(remotePeerId: string | null, error: unknown): void {
    if (this.#events.onError) this.#events.onError(error, remotePeerId);
    else throw error;
  }
}
