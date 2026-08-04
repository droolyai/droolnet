import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import {
  canonicalize,
  decodeMultibase,
  encodeMultibase,
  orderChangeDag,
  sha256Multibase,
  verifyEncryptedChange,
} from './index.js';
import type { DeviceIdentity, EncryptedChange } from './index.js';
import type { MemoryChangeStore } from './storage.js';

const PROTOCOL = 'wokenet.sync.transport';
const VERSION = 1 as const;
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;
const MAX_INVENTORY_IDS = 4_096;
const MAX_WANTED_IDS = 128;
const MAX_BATCH_CHANGES = 128;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const PEER_ID_RE = /^wokeid:v1:u[A-Za-z0-9_-]{43}$/u;
const SPACE_ID_RE = /^wokespace:v1:u[A-Za-z0-9_-]{43}$/u;
const CHANGE_ID_RE = /^wokechange:v1:u[A-Za-z0-9_-]{43}$/u;

export type TransportPayload =
  | Readonly<{ kind: 'inventory'; changeIds: readonly string[] }>
  | Readonly<{ kind: 'want'; changeIds: readonly string[] }>
  | Readonly<{ kind: 'changes'; changes: readonly EncryptedChange[] }>;

export interface PeerHello {
  readonly protocol: typeof PROTOCOL;
  readonly version: typeof VERSION;
  readonly role: 'initiator';
  readonly spaceId: string;
  readonly peerId: string;
  readonly publicKey: string;
  readonly nonce: string;
  readonly createdAt: string;
}

export interface PeerChallenge {
  readonly protocol: typeof PROTOCOL;
  readonly version: typeof VERSION;
  readonly role: 'responder';
  readonly helloHash: string;
  readonly spaceId: string;
  readonly peerId: string;
  readonly publicKey: string;
  readonly nonce: string;
  readonly createdAt: string;
  readonly transcriptHash: string;
  readonly signature: string;
}

export interface PeerAck {
  readonly protocol: typeof PROTOCOL;
  readonly version: typeof VERSION;
  readonly role: 'initiator-ack';
  readonly transcriptHash: string;
  readonly peerId: string;
  readonly signature: string;
}

export interface AuthenticatedPeerSession {
  readonly sessionId: string;
  readonly spaceId: string;
  readonly initiatorPeerId: string;
  readonly initiatorPublicKey: string;
  readonly responderPeerId: string;
  readonly responderPublicKey: string;
  readonly establishedAt: string;
}

export interface SignedTransportFrame {
  readonly header: Readonly<{
    protocol: typeof PROTOCOL;
    version: typeof VERSION;
    sessionId: string;
    spaceId: string;
    sender: string;
    sequence: number;
    kind: TransportPayload['kind'];
  }>;
  readonly payload: TransportPayload;
  readonly payloadHash: string;
  readonly signature: string;
}

export class TransportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

function fail(code: string, message: string): never {
  throw new TransportError(code, message);
}

function canonicalTime(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return fail('invalid_time', 'Handshake time must be canonical UTC.');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return fail('invalid_time', 'Handshake time is invalid.');
  return milliseconds;
}

function assertFresh(value: string, now: Date): void {
  if (Math.abs(now.getTime() - canonicalTime(value)) > MAX_CLOCK_SKEW_MS) {
    fail('stale_handshake', 'Handshake time is outside the accepted clock window.');
  }
}

function assertSpaceId(spaceId: string): void {
  if (!SPACE_ID_RE.test(spaceId)) fail('invalid_space', 'Expected a WOKE space identifier.');
}

function peerIdForPublicKey(publicKeyPem: string): string {
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    return fail('invalid_peer_key', 'Peer public key is invalid.');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    fail('invalid_peer_key', 'Peer identity keys must use Ed25519.');
  }
  const publicDer = publicKey.export({ format: 'der', type: 'spki' });
  return `wokeid:v1:${sha256Multibase(publicDer)}`;
}

function assertPeer(peerId: string, publicKey: string): void {
  if (!PEER_ID_RE.test(peerId) || peerIdForPublicKey(publicKey) !== peerId) {
    fail('peer_identity_mismatch', 'Peer ID does not match its Ed25519 public key.');
  }
}

function nonce(value?: Uint8Array): string {
  const bytes = value ? Buffer.from(value) : randomBytes(32);
  if (bytes.length !== 32) fail('invalid_nonce', 'Transport nonces must contain 32 bytes.');
  return encodeMultibase(bytes);
}

function helloHash(hello: PeerHello): string {
  return sha256Multibase(Buffer.from(canonicalize(hello)));
}

function unsignedChallenge(challenge: PeerChallenge): Omit<PeerChallenge, 'signature'> {
  return {
    protocol: challenge.protocol,
    version: challenge.version,
    role: challenge.role,
    helloHash: challenge.helloHash,
    spaceId: challenge.spaceId,
    peerId: challenge.peerId,
    publicKey: challenge.publicKey,
    nonce: challenge.nonce,
    createdAt: challenge.createdAt,
    transcriptHash: challenge.transcriptHash,
  };
}

function challengeTranscript(
  hello: PeerHello,
  challenge: Omit<PeerChallenge, 'signature' | 'transcriptHash'>,
): string {
  return sha256Multibase(Buffer.from(canonicalize({ challenge, hello })));
}

function signatureFor(identity: DeviceIdentity, value: unknown): string {
  return encodeMultibase(
    sign(null, Buffer.from(canonicalize(value)), createPrivateKey(identity.privateKeyPem)),
  );
}

function verifySignature(publicKeyPem: string, value: unknown, signature: string): boolean {
  try {
    return verify(
      null,
      Buffer.from(canonicalize(value)),
      createPublicKey(publicKeyPem),
      decodeMultibase(signature, 64),
    );
  } catch {
    return false;
  }
}

function validateHello(hello: PeerHello, expectedSpaceId: string, now: Date): void {
  if (hello.protocol !== PROTOCOL || hello.version !== VERSION || hello.role !== 'initiator') {
    fail('unsupported_protocol', 'Unsupported peer hello.');
  }
  assertSpaceId(hello.spaceId);
  if (hello.spaceId !== expectedSpaceId) fail('wrong_space', 'Peer requested a different space.');
  assertPeer(hello.peerId, hello.publicKey);
  decodeMultibase(hello.nonce, 32);
  assertFresh(hello.createdAt, now);
}

export class HandshakeReplayWindow {
  readonly #seen = new Map<string, number>();

  consume(peerId: string, value: string, createdAt: string, now = new Date()): void {
    const nowMs = now.getTime();
    for (const [key, expiresAt] of this.#seen) if (expiresAt < nowMs) this.#seen.delete(key);
    const replayKey = `${peerId}\u0000${value}`;
    if (this.#seen.has(replayKey)) fail('handshake_replay', 'Handshake nonce was already used.');
    this.#seen.set(replayKey, canonicalTime(createdAt) + MAX_CLOCK_SKEW_MS);
  }
}

export function createPeerHello(input: {
  identity: DeviceIdentity;
  spaceId: string;
  createdAt?: string;
  nonce?: Uint8Array;
}): PeerHello {
  assertSpaceId(input.spaceId);
  assertPeer(input.identity.id, input.identity.publicKeyPem);
  return Object.freeze({
    protocol: PROTOCOL,
    version: VERSION,
    role: 'initiator',
    spaceId: input.spaceId,
    peerId: input.identity.id,
    publicKey: input.identity.publicKeyPem,
    nonce: nonce(input.nonce),
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}

export function acceptPeerHello(input: {
  hello: PeerHello;
  responder: DeviceIdentity;
  expectedSpaceId: string;
  replayWindow: HandshakeReplayWindow;
  now?: Date;
  createdAt?: string;
  nonce?: Uint8Array;
}): PeerChallenge {
  const now = input.now ?? new Date();
  validateHello(input.hello, input.expectedSpaceId, now);
  input.replayWindow.consume(input.hello.peerId, input.hello.nonce, input.hello.createdAt, now);
  assertPeer(input.responder.id, input.responder.publicKeyPem);
  if (input.responder.id === input.hello.peerId)
    fail('self_connection', 'A peer cannot connect to itself.');
  const base: Omit<PeerChallenge, 'signature' | 'transcriptHash'> = {
    protocol: PROTOCOL,
    version: VERSION,
    role: 'responder' as const,
    helloHash: helloHash(input.hello),
    spaceId: input.expectedSpaceId,
    peerId: input.responder.id,
    publicKey: input.responder.publicKeyPem,
    nonce: nonce(input.nonce),
    createdAt: input.createdAt ?? now.toISOString(),
  };
  assertFresh(base.createdAt, now);
  const transcriptHash = challengeTranscript(input.hello, base);
  const unsigned = Object.freeze({ ...base, transcriptHash });
  return Object.freeze({ ...unsigned, signature: signatureFor(input.responder, unsigned) });
}

function validateChallenge(
  hello: PeerHello,
  challenge: PeerChallenge,
  expectedSpaceId: string,
  now: Date,
): void {
  if (
    challenge.protocol !== PROTOCOL ||
    challenge.version !== VERSION ||
    challenge.role !== 'responder'
  ) {
    fail('unsupported_protocol', 'Unsupported peer challenge.');
  }
  if (challenge.spaceId !== expectedSpaceId || challenge.spaceId !== hello.spaceId) {
    fail('wrong_space', 'Peer challenge is bound to another space.');
  }
  if (challenge.helloHash !== helloHash(hello)) {
    fail('hello_mismatch', 'Peer challenge does not bind the supplied hello.');
  }
  if (challenge.peerId === hello.peerId)
    fail('self_connection', 'A peer cannot connect to itself.');
  assertPeer(challenge.peerId, challenge.publicKey);
  decodeMultibase(challenge.nonce, 32);
  assertFresh(challenge.createdAt, now);
  const base: Omit<PeerChallenge, 'signature' | 'transcriptHash'> = {
    protocol: challenge.protocol,
    version: challenge.version,
    role: challenge.role,
    helloHash: challenge.helloHash,
    spaceId: challenge.spaceId,
    peerId: challenge.peerId,
    publicKey: challenge.publicKey,
    nonce: challenge.nonce,
    createdAt: challenge.createdAt,
  };
  const expectedTranscript = challengeTranscript(hello, base);
  if (challenge.transcriptHash !== expectedTranscript) {
    fail('transcript_mismatch', 'Handshake transcript hash is invalid.');
  }
  if (!verifySignature(challenge.publicKey, unsignedChallenge(challenge), challenge.signature)) {
    fail('invalid_signature', 'Responder handshake signature is invalid.');
  }
}

function sessionFor(hello: PeerHello, challenge: PeerChallenge): AuthenticatedPeerSession {
  return Object.freeze({
    sessionId: `wokesession:v1:${sha256Multibase(
      Buffer.from(canonicalize({ transcriptHash: challenge.transcriptHash })),
    )}`,
    spaceId: hello.spaceId,
    initiatorPeerId: hello.peerId,
    initiatorPublicKey: hello.publicKey,
    responderPeerId: challenge.peerId,
    responderPublicKey: challenge.publicKey,
    establishedAt: challenge.createdAt,
  });
}

export function acceptPeerChallenge(input: {
  hello: PeerHello;
  challenge: PeerChallenge;
  initiator: DeviceIdentity;
  replayWindow: HandshakeReplayWindow;
  now?: Date;
}): Readonly<{ ack: PeerAck; session: AuthenticatedPeerSession }> {
  const now = input.now ?? new Date();
  validateHello(input.hello, input.hello.spaceId, now);
  if (input.hello.peerId !== input.initiator.id) {
    fail('peer_identity_mismatch', 'Initiator identity does not match the peer hello.');
  }
  validateChallenge(input.hello, input.challenge, input.hello.spaceId, now);
  input.replayWindow.consume(
    input.challenge.peerId,
    input.challenge.nonce,
    input.challenge.createdAt,
    now,
  );
  const unsigned = Object.freeze({
    protocol: PROTOCOL,
    version: VERSION,
    role: 'initiator-ack' as const,
    transcriptHash: input.challenge.transcriptHash,
    peerId: input.initiator.id,
  });
  const ack = Object.freeze({ ...unsigned, signature: signatureFor(input.initiator, unsigned) });
  return Object.freeze({ ack, session: sessionFor(input.hello, input.challenge) });
}

export function finalizePeerHandshake(input: {
  hello: PeerHello;
  challenge: PeerChallenge;
  ack: PeerAck;
  responder: DeviceIdentity;
  now?: Date;
}): AuthenticatedPeerSession {
  const now = input.now ?? new Date();
  validateHello(input.hello, input.hello.spaceId, now);
  validateChallenge(input.hello, input.challenge, input.hello.spaceId, now);
  if (input.responder.id !== input.challenge.peerId) {
    fail('peer_identity_mismatch', 'Responder identity does not match its challenge.');
  }
  if (
    input.ack.protocol !== PROTOCOL ||
    input.ack.version !== VERSION ||
    input.ack.role !== 'initiator-ack' ||
    input.ack.peerId !== input.hello.peerId ||
    input.ack.transcriptHash !== input.challenge.transcriptHash
  ) {
    fail('ack_mismatch', 'Initiator acknowledgement does not bind this handshake.');
  }
  const unsigned: Omit<PeerAck, 'signature'> = {
    protocol: input.ack.protocol,
    version: input.ack.version,
    role: input.ack.role,
    transcriptHash: input.ack.transcriptHash,
    peerId: input.ack.peerId,
  };
  if (!verifySignature(input.hello.publicKey, unsigned, input.ack.signature)) {
    fail('invalid_signature', 'Initiator handshake signature is invalid.');
  }
  return sessionFor(input.hello, input.challenge);
}

function sortedUniqueIds(
  values: readonly string[],
  maximum: number,
  kind: 'inventory' | 'want',
): readonly string[] {
  if (!Array.isArray(values) || values.length > maximum) {
    fail('frame_too_large', `${kind} exceeds its identifier limit.`);
  }
  const sorted = [...values].sort();
  if (
    new Set(sorted).size !== sorted.length ||
    sorted.some((value, index) => !CHANGE_ID_RE.test(value) || value !== values[index])
  ) {
    fail('invalid_change_ids', `${kind} identifiers must be valid, unique, and sorted.`);
  }
  return Object.freeze(sorted);
}

function validatePayload(payload: TransportPayload, spaceId: string): void {
  if (!payload || typeof payload !== 'object') fail('invalid_payload', 'Frame payload is invalid.');
  if (payload.kind === 'inventory') {
    sortedUniqueIds(payload.changeIds, MAX_INVENTORY_IDS, 'inventory');
  } else if (payload.kind === 'want') {
    sortedUniqueIds(payload.changeIds, MAX_WANTED_IDS, 'want');
  } else if (payload.kind === 'changes') {
    if (!Array.isArray(payload.changes) || payload.changes.length > MAX_BATCH_CHANGES) {
      fail('frame_too_large', 'Change batch exceeds its item limit.');
    }
    for (const change of payload.changes) {
      verifyEncryptedChange(change);
      if (change.header.spaceId !== spaceId) fail('wrong_space', 'Change batch mixes spaces.');
    }
  } else {
    fail('invalid_payload', 'Unsupported frame payload kind.');
  }
  if (Buffer.byteLength(canonicalize(payload)) > MAX_FRAME_BYTES) {
    fail('frame_too_large', 'Frame payload exceeds four MiB.');
  }
}

function publicKeyForPeer(session: AuthenticatedPeerSession, peerId: string): string {
  if (peerId === session.initiatorPeerId) return session.initiatorPublicKey;
  if (peerId === session.responderPeerId) return session.responderPublicKey;
  return fail('unknown_peer', 'Frame sender is not part of this session.');
}

export function createTransportFrame(input: {
  session: AuthenticatedPeerSession;
  identity: DeviceIdentity;
  sequence: number;
  payload: TransportPayload;
}): SignedTransportFrame {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    fail('invalid_sequence', 'Frame sequence must be a non-negative safe integer.');
  }
  const publicKey = publicKeyForPeer(input.session, input.identity.id);
  if (publicKey !== input.identity.publicKeyPem) {
    fail('peer_identity_mismatch', 'Frame identity is not bound to this session.');
  }
  validatePayload(input.payload, input.session.spaceId);
  const payloadHash = sha256Multibase(Buffer.from(canonicalize(input.payload)));
  const header = Object.freeze({
    protocol: PROTOCOL,
    version: VERSION,
    sessionId: input.session.sessionId,
    spaceId: input.session.spaceId,
    sender: input.identity.id,
    sequence: input.sequence,
    kind: input.payload.kind,
  });
  const descriptor = Object.freeze({ header, payloadHash });
  return Object.freeze({
    header,
    payload: input.payload,
    payloadHash,
    signature: signatureFor(input.identity, descriptor),
  });
}

export function verifyTransportFrame(input: {
  frame: SignedTransportFrame;
  session: AuthenticatedPeerSession;
  expectedSender: string;
  expectedSequence: number;
}): TransportPayload {
  const { frame, session } = input;
  if (
    frame.header.protocol !== PROTOCOL ||
    frame.header.version !== VERSION ||
    frame.header.sessionId !== session.sessionId ||
    frame.header.spaceId !== session.spaceId
  ) {
    fail('session_mismatch', 'Frame is not bound to this authenticated session.');
  }
  if (frame.header.sender !== input.expectedSender) {
    fail('unexpected_sender', 'Frame sender is not the expected remote peer.');
  }
  if (frame.header.sequence !== input.expectedSequence) {
    fail('sequence_mismatch', 'Frame is replayed, missing, or out of order.');
  }
  if (frame.header.kind !== frame.payload.kind) fail('payload_mismatch', 'Frame kind mismatch.');
  validatePayload(frame.payload, session.spaceId);
  const payloadHash = sha256Multibase(Buffer.from(canonicalize(frame.payload)));
  if (payloadHash !== frame.payloadHash) fail('payload_tampered', 'Frame payload hash mismatch.');
  const descriptor = Object.freeze({ header: frame.header, payloadHash: frame.payloadHash });
  if (
    !verifySignature(publicKeyForPeer(session, frame.header.sender), descriptor, frame.signature)
  ) {
    fail('invalid_signature', 'Frame signature is invalid.');
  }
  return frame.payload;
}

export class PeerFrameReceiver {
  #nextSequence = 0;

  constructor(
    readonly session: AuthenticatedPeerSession,
    readonly remotePeerId: string,
  ) {
    publicKeyForPeer(session, remotePeerId);
  }

  get nextSequence(): number {
    return this.#nextSequence;
  }

  accept(frame: SignedTransportFrame): TransportPayload {
    const payload = verifyTransportFrame({
      frame,
      session: this.session,
      expectedSender: this.remotePeerId,
      expectedSequence: this.#nextSequence,
    });
    this.#nextSequence += 1;
    return payload;
  }
}

export function inventoryPayload(store: MemoryChangeStore): TransportPayload {
  return Object.freeze({
    kind: 'inventory',
    changeIds: Object.freeze(
      store
        .list()
        .map((change) => change.changeId)
        .sort(),
    ),
  });
}

export function wantedPayload(
  store: MemoryChangeStore,
  remoteInventory: TransportPayload,
): TransportPayload {
  if (remoteInventory.kind !== 'inventory') {
    return fail('invalid_payload', 'Expected a remote inventory payload.');
  }
  const wanted = store.missing(remoteInventory.changeIds).slice(0, MAX_WANTED_IDS);
  return Object.freeze({ kind: 'want', changeIds: Object.freeze([...wanted].sort()) });
}

export function changesPayload(
  store: MemoryChangeStore,
  wanted: TransportPayload,
): TransportPayload {
  if (wanted.kind !== 'want') return fail('invalid_payload', 'Expected a wanted-change payload.');
  const changes = wanted.changeIds.map((changeId) => {
    const change = store.get(changeId);
    if (!change) return fail('change_unavailable', 'Requested change is unavailable.');
    return change;
  });
  return Object.freeze({ kind: 'changes', changes: Object.freeze(changes) });
}

export function applyChangesPayload(store: MemoryChangeStore, payload: TransportPayload): number {
  if (payload.kind !== 'changes') return fail('invalid_payload', 'Expected a change batch.');
  const existing = store.list();
  if (!existing.length && !payload.changes.length) return 0;
  const expectedSpaceId = existing[0]?.header.spaceId ?? payload.changes[0]?.header.spaceId;
  if (!expectedSpaceId) return 0;
  validatePayload(payload, expectedSpaceId);
  const unseen = payload.changes.filter((change) => store.get(change.changeId) === null);
  orderChangeDag([...existing, ...unseen]);
  return store.putMany(unseen);
}

export const TRANSPORT_CONTRACT = Object.freeze({
  protocol: PROTOCOL,
  version: VERSION,
  status: 'authenticated_replication_core_verified',
  mutualAuthentication: 'Ed25519 transcript signatures',
  replayProtection: 'nonce window plus monotonic frame sequence',
  payloadEncryption: 'encrypted changes only',
  carrierEncryptionRequired: true,
  carriersImplemented: [],
  libp2pNoiseCarrier: 'not_implemented',
  webTransportCarrier: 'not_implemented',
  relayAndNatTraversal: 'not_implemented',
});
