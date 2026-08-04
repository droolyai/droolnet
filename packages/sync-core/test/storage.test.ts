import { describe, expect, it } from "vitest";
import { createEncryptedChange, generateIdentity, generateSpaceKey } from "../src/index.js";
import { MemoryChangeStore, StorageError, generateStorageKey, openStoreSnapshot, sealStoreSnapshot } from "../src/storage.js";

describe("encrypted local change storage", () => {
  it("stores verified changes idempotently and computes stable heads", () => {
    const identity = generateIdentity(); const spaceKey = generateSpaceKey();
    const root = createEncryptedChange({ identity, spaceKey, kind: "social.object.put", payload: { root: true }, createdAt: "2026-08-04T10:00:00.000Z" });
    const child = createEncryptedChange({ identity, spaceKey, kind: "social.object.put", payload: { child: true }, parents: [root.changeId], createdAt: "2026-08-04T10:01:00.000Z" });
    const store = new MemoryChangeStore();
    expect(store.putMany([child, root, child])).toBe(2);
    expect(store.receipt().heads).toEqual([child.changeId]);
    expect(store.missing([root.changeId, "wokechange:v1:uAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"])).toEqual(["wokechange:v1:uAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]);
  });

  it("seals all store metadata and ciphertext at rest and restores verified changes", () => {
    const identity = generateIdentity(); const spaceKey = generateSpaceKey(); const storageKey = generateStorageKey();
    const change = createEncryptedChange({ identity, spaceKey, kind: "social.object.put", payload: { text: "private draft" }, createdAt: "2026-08-04T10:00:00.000Z" });
    const snapshot = sealStoreSnapshot({ changes: [change], storageKey, createdAt: "2026-08-04T10:02:00.000Z", nonce: new Uint8Array(12).fill(9) });
    expect(snapshot.ciphertext).not.toContain("private draft");
    const restored = openStoreSnapshot(snapshot, storageKey);
    expect(restored.get(change.changeId)).toEqual(change);
    expect(restored.receipt().root).toBe(snapshot.metadata.root);
  });

  it("rejects wrong keys, tampered snapshots, mixed spaces, and incomplete ancestry", () => {
    const identity = generateIdentity(); const firstKey = generateSpaceKey(); const secondKey = generateSpaceKey(); const storageKey = generateStorageKey();
    const first = createEncryptedChange({ identity, spaceKey: firstKey, kind: "social.object.put", payload: { n: 1 } });
    const second = createEncryptedChange({ identity, spaceKey: secondKey, kind: "social.object.put", payload: { n: 2 } });
    expect(() => sealStoreSnapshot({ changes: [first, second], storageKey })).toThrow(StorageError);
    const snapshot = sealStoreSnapshot({ changes: [first], storageKey });
    expect(() => openStoreSnapshot(snapshot, generateStorageKey())).toThrow(StorageError);
    expect(() => openStoreSnapshot({ ...snapshot, ciphertext: `${snapshot.ciphertext.slice(0, -1)}A` }, storageKey)).toThrow(StorageError);
  });
});
