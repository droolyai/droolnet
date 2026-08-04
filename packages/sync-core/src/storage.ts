import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { type EncryptedChange, canonicalize, decodeMultibase, encodeMultibase, orderChangeDag, sha256Multibase, verifyEncryptedChange } from "./index.js";

const PROTOCOL = "wokenet.store.snapshot";
export interface StoreReceipt { spaceId: string; changeCount: number; heads: readonly string[]; root: string }
export interface SealedStoreSnapshot { metadata: Readonly<{ protocol: typeof PROTOCOL; version: 1; createdAt: string; spaceId: string; changeCount: number; root: string; nonce: string }>; ciphertext: string; snapshotHash: string }

export class StorageError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "StorageError"; }
}
function fail(code: string, message: string): never { throw new StorageError(code, message); }
function receiptFor(changes: readonly EncryptedChange[]): StoreReceipt {
  if (!changes.length) fail("empty_store", "A sync store must contain at least one verified change.");
  const ordered = orderChangeDag(changes); const first = ordered[0]; if (!first) fail("empty_store", "A sync store must contain at least one verified change."); const spaceId = first.header.spaceId;
  if (ordered.some((change) => change.header.spaceId !== spaceId)) fail("mixed_spaces", "A store snapshot may contain only one space.");
  const parentIds = new Set(ordered.flatMap((change) => [...change.header.parents])); const heads = ordered.map((change) => change.changeId).filter((changeId) => !parentIds.has(changeId)).sort();
  return Object.freeze({ spaceId, changeCount: ordered.length, heads: Object.freeze(heads), root: sha256Multibase(Buffer.from(canonicalize(ordered.map((change) => change.changeId).sort()))) });
}

export class MemoryChangeStore {
  readonly #changes = new Map<string, EncryptedChange>();
  put(change: EncryptedChange): boolean {
    verifyEncryptedChange(change); const existing = this.#changes.get(change.changeId);
    if (existing) { if (canonicalize(existing) !== canonicalize(change)) fail("change_collision", "A change ID collision was detected."); return false; }
    this.#changes.set(change.changeId, change); return true;
  }
  putMany(changes: readonly EncryptedChange[]): number { let inserted = 0; for (const change of changes) if (this.put(change)) inserted += 1; return inserted; }
  get(changeId: string): EncryptedChange | null { return this.#changes.get(changeId) ?? null; }
  list(): readonly EncryptedChange[] { return Object.freeze([...this.#changes.values()].sort((a, b) => a.changeId.localeCompare(b.changeId))); }
  receipt(): StoreReceipt { return receiptFor(this.list()); }
  missing(candidateIds: readonly string[]): readonly string[] { return Object.freeze([...new Set(candidateIds)].filter((id) => !this.#changes.has(id)).sort()); }
}

export function generateStorageKey(): Uint8Array { return randomBytes(32); }
export function sealStoreSnapshot(input: { changes: readonly EncryptedChange[]; storageKey: Uint8Array; createdAt?: string; nonce?: Uint8Array }): SealedStoreSnapshot {
  if (input.storageKey.length !== 32) fail("invalid_storage_key", "Storage keys must contain 32 bytes.");
  const receipt = receiptFor(input.changes); const nonce = input.nonce ? Buffer.from(input.nonce) : randomBytes(12); if (nonce.length !== 12) fail("invalid_nonce", "Storage nonce must contain 12 bytes.");
  const metadata = Object.freeze({ protocol: PROTOCOL, version: 1 as const, createdAt: input.createdAt ?? new Date().toISOString(), spaceId: receipt.spaceId, changeCount: receipt.changeCount, root: receipt.root, nonce: encodeMultibase(nonce) });
  const plaintext = Buffer.from(canonicalize(orderChangeDag(input.changes))); const cipher = createCipheriv("aes-256-gcm", input.storageKey, nonce); cipher.setAAD(Buffer.from(canonicalize(metadata)));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]); const ciphertext = encodeMultibase(encrypted);
  return Object.freeze({ metadata, ciphertext, snapshotHash: sha256Multibase(Buffer.from(canonicalize({ metadata, ciphertext }))) });
}

export function openStoreSnapshot(snapshot: SealedStoreSnapshot, storageKey: Uint8Array): MemoryChangeStore {
  if (storageKey.length !== 32 || snapshot.metadata.protocol !== PROTOCOL || snapshot.metadata.version !== 1) fail("invalid_snapshot", "Snapshot contract or storage key is invalid.");
  if (snapshot.snapshotHash !== sha256Multibase(Buffer.from(canonicalize({ metadata: snapshot.metadata, ciphertext: snapshot.ciphertext })))) fail("snapshot_tampered", "Snapshot hash mismatch.");
  const encrypted = decodeMultibase(snapshot.ciphertext); if (encrypted.length < 17) fail("invalid_snapshot", "Snapshot ciphertext is too short.");
  const decipher = createDecipheriv("aes-256-gcm", storageKey, decodeMultibase(snapshot.metadata.nonce, 12)); decipher.setAAD(Buffer.from(canonicalize(snapshot.metadata))); decipher.setAuthTag(encrypted.subarray(-16));
  let changes: unknown;
  try { changes = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString()); } catch { return fail("snapshot_open_failed", "Snapshot authentication or decoding failed."); }
  if (!Array.isArray(changes)) fail("invalid_snapshot", "Snapshot content must be a change list.");
  const store = new MemoryChangeStore(); store.putMany(changes as EncryptedChange[]); const receipt = store.receipt();
  if (receipt.spaceId !== snapshot.metadata.spaceId || receipt.changeCount !== snapshot.metadata.changeCount || receipt.root !== snapshot.metadata.root) fail("snapshot_receipt_mismatch", "Snapshot metadata does not match verified contents.");
  return store;
}

export const STORAGE_CONTRACT = Object.freeze({ memoryStore: "implemented", encryptedSnapshot: "implemented", atRestEncryption: "AES-256-GCM", indexedDbAdapter: "not_implemented", sqliteAdapter: "not_implemented", atomicFileAdapter: "not_implemented" });
