import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';

const PROTOCOL = 'wokenet.sync.change';
const VERSION = 1 as const;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const ID_RE = /^(?:wokeid|wokespace|wokechange):v1:u[A-Za-z0-9_-]{43}$/u;
export type ChangeKind =
  'social.object.put' | 'social.object.delete' | 'membership.rotate' | 'snapshot';
export interface DeviceIdentity {
  id: string;
  publicKeyPem: string;
  privateKeyPem: string;
}
export interface ChangeHeader {
  protocol: typeof PROTOCOL;
  version: typeof VERSION;
  spaceId: string;
  author: string;
  kind: ChangeKind;
  createdAt: string;
  parents: readonly string[];
  nonce: string;
}
export interface EncryptedChange {
  header: ChangeHeader;
  ciphertext: string;
  ciphertextHash: string;
  publicKey: string;
  signature: string;
  changeId: string;
}

export class SyncCoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SyncCoreError';
  }
}
function fail(code: string, message: string): never {
  throw new SyncCoreError(code, message);
}
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(',')}}`;
  }
  return fail('invalid_value', 'Canonical values must be finite JSON data.');
}
export function encodeMultibase(bytes: Uint8Array): string {
  return `u${Buffer.from(bytes).toString('base64url')}`;
}
export function decodeMultibase(value: string, expected?: number): Buffer {
  if (typeof value !== 'string' || !/^u[A-Za-z0-9_-]+$/u.test(value))
    fail('invalid_encoding', 'Expected base64url multibase data.');
  const bytes = Buffer.from(value.slice(1), 'base64url');
  if (encodeMultibase(bytes) !== value || (expected !== undefined && bytes.length !== expected))
    fail('invalid_encoding', 'Encoded data has an invalid length or representation.');
  return bytes;
}
export function sha256Multibase(bytes: Uint8Array | string): string {
  return encodeMultibase(createHash('sha256').update(bytes).digest());
}
function id(prefix: 'wokeid' | 'wokespace' | 'wokechange', bytes: Uint8Array | string): string {
  return `${prefix}:v1:${sha256Multibase(bytes)}`;
}
function descriptor(header: ChangeHeader, ciphertextHash: string): string {
  return canonicalize({ ciphertextHash, header });
}
function validateId(value: string, prefix: 'wokeid' | 'wokespace' | 'wokechange'): void {
  if (!ID_RE.test(value) || !value.startsWith(`${prefix}:`))
    fail('invalid_id', `Expected a ${prefix} v1 identifier.`);
}
function validateHeader(header: ChangeHeader): void {
  if (header.protocol !== PROTOCOL || header.version !== VERSION)
    fail('unsupported_protocol', 'Unsupported sync protocol.');
  validateId(header.spaceId, 'wokespace');
  validateId(header.author, 'wokeid');
  if (
    !['social.object.put', 'social.object.delete', 'membership.rotate', 'snapshot'].includes(
      header.kind,
    )
  )
    fail('invalid_kind', 'Unsupported change kind.');
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(header.createdAt) ||
    !Number.isFinite(Date.parse(header.createdAt))
  )
    fail('invalid_time', 'createdAt must be canonical UTC.');
  decodeMultibase(header.nonce, 12);
  if (!Array.isArray(header.parents) || header.parents.length > 32)
    fail('invalid_parents', 'At most 32 parents are allowed.');
  const sorted = [...header.parents].sort();
  if (
    new Set(sorted).size !== sorted.length ||
    sorted.some((parent, index) => parent !== header.parents[index])
  )
    fail('invalid_parents', 'Parents must be unique and sorted.');
  for (const parent of header.parents) validateId(parent, 'wokechange');
}
export function generateIdentity(): DeviceIdentity {
  const pair = generateKeyPairSync('ed25519');
  const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' });
  return Object.freeze({
    id: id('wokeid', publicDer),
    publicKeyPem: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    privateKeyPem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  });
}
export function generateSpaceKey(): Uint8Array {
  return randomBytes(32);
}
export function deriveSpaceId(spaceKey: Uint8Array): string {
  if (!(spaceKey instanceof Uint8Array) || spaceKey.length !== 32)
    fail('invalid_space_key', 'Space keys must contain 32 bytes.');
  return id('wokespace', Buffer.concat([Buffer.from(PROTOCOL), Buffer.from(spaceKey)]));
}
export function createEncryptedChange(input: {
  identity: DeviceIdentity;
  spaceKey: Uint8Array;
  kind: ChangeKind;
  payload: unknown;
  parents?: readonly string[];
  createdAt?: string;
  nonce?: Uint8Array;
}): EncryptedChange {
  const nonce = input.nonce ? Buffer.from(input.nonce) : randomBytes(12);
  if (nonce.length !== 12) fail('invalid_nonce', 'AES-GCM nonces must contain 12 bytes.');
  const header: ChangeHeader = Object.freeze({
    protocol: PROTOCOL,
    version: VERSION,
    spaceId: deriveSpaceId(input.spaceKey),
    author: input.identity.id,
    kind: input.kind,
    createdAt: input.createdAt ?? new Date().toISOString(),
    parents: Object.freeze([...(input.parents ?? [])].sort()),
    nonce: encodeMultibase(nonce),
  });
  validateHeader(header);
  const plaintext = Buffer.from(canonicalize(input.payload));
  if (plaintext.length > MAX_PAYLOAD_BYTES) fail('payload_too_large', 'Payload exceeds 256 KiB.');
  const cipher = createCipheriv('aes-256-gcm', input.spaceKey, nonce);
  cipher.setAAD(Buffer.from(canonicalize(header)));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const ciphertextHash = sha256Multibase(encrypted);
  const signed = descriptor(header, ciphertextHash);
  const signature = encodeMultibase(
    sign(null, Buffer.from(signed), createPrivateKey(input.identity.privateKeyPem)),
  );
  return Object.freeze({
    header,
    ciphertext: encodeMultibase(encrypted),
    ciphertextHash,
    publicKey: input.identity.publicKeyPem,
    signature,
    changeId: id('wokechange', Buffer.from(canonicalize({ descriptor: signed, signature }))),
  });
}
export function verifyEncryptedChange(change: EncryptedChange): true {
  validateHeader(change.header);
  validateId(change.changeId, 'wokechange');
  const publicKey = createPublicKey(change.publicKey);
  const publicDer = publicKey.export({ format: 'der', type: 'spki' });
  if (id('wokeid', publicDer) !== change.header.author)
    fail('author_mismatch', 'Public key does not match author ID.');
  const encrypted = decodeMultibase(change.ciphertext);
  if (sha256Multibase(encrypted) !== change.ciphertextHash)
    fail('ciphertext_tampered', 'Ciphertext hash mismatch.');
  const signed = descriptor(change.header, change.ciphertextHash);
  if (!verify(null, Buffer.from(signed), publicKey, decodeMultibase(change.signature, 64)))
    fail('invalid_signature', 'Change signature is invalid.');
  if (
    id(
      'wokechange',
      Buffer.from(canonicalize({ descriptor: signed, signature: change.signature })),
    ) !== change.changeId
  )
    fail('invalid_change_id', 'Change ID mismatch.');
  return true;
}
export function decryptChange(change: EncryptedChange, spaceKey: Uint8Array): unknown {
  verifyEncryptedChange(change);
  if (deriveSpaceId(spaceKey) !== change.header.spaceId)
    fail('wrong_space_key', 'Space key does not match this change.');
  const encrypted = decodeMultibase(change.ciphertext);
  if (encrypted.length < 16) fail('invalid_ciphertext', 'Ciphertext is too short.');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    spaceKey,
    decodeMultibase(change.header.nonce, 12),
  );
  decipher.setAAD(Buffer.from(canonicalize(change.header)));
  decipher.setAuthTag(encrypted.subarray(-16));
  try {
    return JSON.parse(
      Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString(),
    );
  } catch {
    return fail('decrypt_failed', 'Ciphertext authentication failed.');
  }
}
export function orderChangeDag(changes: readonly EncryptedChange[]): readonly EncryptedChange[] {
  const pending = new Map<string, EncryptedChange>();
  for (const change of changes) {
    verifyEncryptedChange(change);
    if (pending.has(change.changeId)) fail('duplicate_change', 'Duplicate change ID.');
    pending.set(change.changeId, change);
  }
  const emitted = new Set<string>();
  const ordered: EncryptedChange[] = [];
  while (pending.size) {
    const ready = [...pending.values()]
      .filter((change) => change.header.parents.every((parent) => emitted.has(parent)))
      .sort(
        (a, b) =>
          a.header.createdAt.localeCompare(b.header.createdAt) ||
          a.changeId.localeCompare(b.changeId),
      );
    if (!ready.length)
      fail('missing_or_cyclic_parent', 'Change DAG has a missing parent or cycle.');
    for (const change of ready) {
      pending.delete(change.changeId);
      emitted.add(change.changeId);
      ordered.push(change);
    }
  }
  return Object.freeze(ordered);
}
export const SYNC_CORE_CONTRACT = Object.freeze({
  protocol: PROTOCOL,
  version: VERSION,
  status: 'local_first_social_core_verified',
  encryption: 'AES-256-GCM',
  signatures: 'Ed25519',
  contentAddressing: 'SHA-256',
  socialCrdt: 'implemented_research_subset',
  deviceDelegation: 'implemented',
  x25519SpaceKeyWrapping: 'implemented',
  encryptedStoreSnapshots: 'implemented',
  transport: 'authenticated_replication_core_verified',
  peerDiscovery: 'not_implemented',
  revocationDistribution: 'not_implemented',
  recovery: 'not_implemented',
  productionE2eeMessaging: false,
});
