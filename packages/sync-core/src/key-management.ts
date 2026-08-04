import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify } from "node:crypto";
import { type DeviceIdentity, canonicalize, decodeMultibase, encodeMultibase, sha256Multibase } from "./index.js";

const DELEGATION_PROTOCOL = "wokenet.identity.delegation";
const WRAP_PROTOCOL = "wokenet.space-key.wrap";
const BOX_RE = /^wokebox:v1:u[A-Za-z0-9_-]{43}$/u;
const DEVICE_RE = /^wokeid:v1:u[A-Za-z0-9_-]{43}$/u;
export type DeviceRole = "social.write" | "social.moderate" | "space.admin" | "node.serve";

export interface EncryptionIdentity { id: string; publicKeyPem: string; privateKeyPem: string }
export interface DelegationCertificate {
  payload: Readonly<{ protocol: typeof DELEGATION_PROTOCOL; version: 1; rootId: string; deviceId: string; deviceSigningPublicKeyPem: string; deviceEncryptionId: string; deviceEncryptionPublicKeyPem: string; roles: readonly DeviceRole[]; notBefore: string; notAfter: string; serial: string }>;
  proof: Readonly<{ algorithm: "Ed25519"; rootPublicKeyPem: string; signature: string }>;
}
export interface WrappedSpaceKey {
  metadata: Readonly<{ protocol: typeof WRAP_PROTOCOL; version: 1; spaceId: string; epoch: number; recipientDeviceId: string; recipientEncryptionId: string; ephemeralPublicKeyPem: string; nonce: string }>;
  ciphertext: string;
  wrapHash: string;
}

export class KeyManagementError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "KeyManagementError"; }
}
function fail(code: string, message: string): never { throw new KeyManagementError(code, message); }
function canonicalTime(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)); }
function publicDer(pem: string): Buffer { return createPublicKey(pem).export({ format: "der", type: "spki" }); }
function deviceId(pem: string): string { return `wokeid:v1:${sha256Multibase(publicDer(pem))}`; }
function boxId(pem: string): string { return `wokebox:v1:${sha256Multibase(publicDer(pem))}`; }
function deriveWrapKey(sharedSecret: Buffer, spaceId: string, epoch: number): Buffer { return Buffer.from(hkdfSync("sha256", sharedSecret, Buffer.from(spaceId), Buffer.from(`${WRAP_PROTOCOL}:${epoch}`), 32)); }

export function generateEncryptionIdentity(): EncryptionIdentity {
  const pair = generateKeyPairSync("x25519");
  const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  return Object.freeze({ id: boxId(publicKeyPem), publicKeyPem, privateKeyPem: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString() });
}

export function createDelegationCertificate(input: { root: DeviceIdentity; device: DeviceIdentity; encryption: EncryptionIdentity; roles: readonly DeviceRole[]; notBefore: string; notAfter: string; serial?: string }): DelegationCertificate {
  const roles = [...new Set(input.roles)].sort();
  if (!roles.length || roles.some((role) => !["social.write", "social.moderate", "space.admin", "node.serve"].includes(role))) fail("invalid_roles", "Delegation roles are invalid.");
  if (!canonicalTime(input.notBefore) || !canonicalTime(input.notAfter) || Date.parse(input.notAfter) <= Date.parse(input.notBefore)) fail("invalid_window", "Delegation validity window is invalid.");
  if (deviceId(input.root.publicKeyPem) !== input.root.id || deviceId(input.device.publicKeyPem) !== input.device.id || boxId(input.encryption.publicKeyPem) !== input.encryption.id) fail("identity_mismatch", "Identity IDs must match their public keys.");
  const payload = Object.freeze({ protocol: DELEGATION_PROTOCOL, version: 1 as const, rootId: input.root.id, deviceId: input.device.id, deviceSigningPublicKeyPem: input.device.publicKeyPem, deviceEncryptionId: input.encryption.id, deviceEncryptionPublicKeyPem: input.encryption.publicKeyPem, roles: Object.freeze(roles), notBefore: input.notBefore, notAfter: input.notAfter, serial: input.serial ?? encodeMultibase(randomBytes(16)) });
  const signature = encodeMultibase(sign(null, Buffer.from(canonicalize(payload)), createPrivateKey(input.root.privateKeyPem)));
  return Object.freeze({ payload, proof: Object.freeze({ algorithm: "Ed25519" as const, rootPublicKeyPem: input.root.publicKeyPem, signature }) });
}

export function verifyDelegationCertificate(certificate: DelegationCertificate, at = new Date()): true {
  const { payload, proof } = certificate;
  if (payload.protocol !== DELEGATION_PROTOCOL || payload.version !== 1 || proof.algorithm !== "Ed25519") fail("unsupported_delegation", "Unsupported delegation certificate.");
  if (!DEVICE_RE.test(payload.rootId) || !DEVICE_RE.test(payload.deviceId) || !BOX_RE.test(payload.deviceEncryptionId)) fail("invalid_identity", "Delegation identity is invalid.");
  if (deviceId(proof.rootPublicKeyPem) !== payload.rootId || deviceId(payload.deviceSigningPublicKeyPem) !== payload.deviceId || boxId(payload.deviceEncryptionPublicKeyPem) !== payload.deviceEncryptionId) fail("identity_mismatch", "Delegation public keys do not match IDs.");
  if (!verify(null, Buffer.from(canonicalize(payload)), createPublicKey(proof.rootPublicKeyPem), decodeMultibase(proof.signature, 64))) fail("invalid_delegation_signature", "Root delegation signature is invalid.");
  const time = at.getTime(); if (time < Date.parse(payload.notBefore) || time >= Date.parse(payload.notAfter)) fail("delegation_inactive", "Delegation is not active at this time.");
  return true;
}

export function wrapSpaceKey(input: { certificate: DelegationCertificate; spaceId: string; epoch: number; spaceKey: Uint8Array; at?: Date; nonce?: Uint8Array }): WrappedSpaceKey {
  verifyDelegationCertificate(input.certificate, input.at);
  if (!/^wokespace:v1:u[A-Za-z0-9_-]{43}$/u.test(input.spaceId) || !Number.isSafeInteger(input.epoch) || input.epoch < 1 || input.spaceKey.length !== 32) fail("invalid_wrap_input", "Space key wrap parameters are invalid.");
  const ephemeral = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: createPublicKey(input.certificate.payload.deviceEncryptionPublicKeyPem) });
  const key = deriveWrapKey(shared, input.spaceId, input.epoch); const nonce = input.nonce ? Buffer.from(input.nonce) : randomBytes(12); if (nonce.length !== 12) fail("invalid_nonce", "Wrap nonce must contain 12 bytes.");
  const metadata = Object.freeze({ protocol: WRAP_PROTOCOL, version: 1 as const, spaceId: input.spaceId, epoch: input.epoch, recipientDeviceId: input.certificate.payload.deviceId, recipientEncryptionId: input.certificate.payload.deviceEncryptionId, ephemeralPublicKeyPem: ephemeral.publicKey.export({ format: "pem", type: "spki" }).toString(), nonce: encodeMultibase(nonce) });
  const cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(Buffer.from(canonicalize(metadata)));
  const encrypted = Buffer.concat([cipher.update(input.spaceKey), cipher.final(), cipher.getAuthTag()]); const ciphertext = encodeMultibase(encrypted);
  return Object.freeze({ metadata, ciphertext, wrapHash: sha256Multibase(Buffer.from(canonicalize({ metadata, ciphertext }))) });
}

export function unwrapSpaceKey(input: { wrapped: WrappedSpaceKey; device: DeviceIdentity; encryption: EncryptionIdentity }): Buffer {
  const { metadata, ciphertext, wrapHash } = input.wrapped;
  if (metadata.protocol !== WRAP_PROTOCOL || metadata.version !== 1 || metadata.recipientDeviceId !== input.device.id || metadata.recipientEncryptionId !== input.encryption.id) fail("wrong_recipient", "Wrapped key is not addressed to this device.");
  if (wrapHash !== sha256Multibase(Buffer.from(canonicalize({ metadata, ciphertext })))) fail("wrap_tampered", "Wrapped key hash mismatch.");
  if (deviceId(input.device.publicKeyPem) !== input.device.id || boxId(input.encryption.publicKeyPem) !== input.encryption.id) fail("identity_mismatch", "Recipient identity mismatch.");
  const shared = diffieHellman({ privateKey: createPrivateKey(input.encryption.privateKeyPem), publicKey: createPublicKey(metadata.ephemeralPublicKeyPem) });
  const key = deriveWrapKey(shared, metadata.spaceId, metadata.epoch); const encrypted = decodeMultibase(ciphertext); if (encrypted.length !== 48) fail("invalid_wrapped_key", "Wrapped space key must contain 32 encrypted bytes and a 16-byte tag.");
  const decipher = createDecipheriv("aes-256-gcm", key, decodeMultibase(metadata.nonce, 12)); decipher.setAAD(Buffer.from(canonicalize(metadata))); decipher.setAuthTag(encrypted.subarray(-16));
  try { return Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]); } catch { return fail("unwrap_failed", "Wrapped key authentication failed."); }
}

export const KEY_MANAGEMENT_CONTRACT = Object.freeze({ delegation: "Ed25519_root_signed_device_certificates", keyAgreement: "X25519", keyWrapping: "HKDF-SHA256_plus_AES-256-GCM", epochs: "supported_by_wrap_metadata", revocationDistribution: "not_implemented", recovery: "not_implemented", externallyAudited: false });
