import { describe, expect, it } from "vitest";
import { SyncCoreError, createEncryptedChange, decryptChange, deriveSpaceId, generateIdentity, generateSpaceKey, orderChangeDag, verifyEncryptedChange } from "../src/index.js";

describe("encrypted local-first social change DAG", () => {
  it("encrypts, signs, verifies, and decrypts without plaintext leakage", () => {
    const identity = generateIdentity(); const spaceKey = generateSpaceKey();
    const change = createEncryptedChange({ identity, spaceKey, kind: "social.object.put", payload: { type: "post", text: "ICEFAM owns its graph" }, createdAt: "2026-08-04T08:00:00.000Z", nonce: new Uint8Array(12).fill(7) });
    expect(change.header.spaceId).toBe(deriveSpaceId(spaceKey));
    expect(change.ciphertext).not.toContain("ICEFAM");
    expect(verifyEncryptedChange(change)).toBe(true);
    expect(decryptChange(change, spaceKey)).toEqual({ text: "ICEFAM owns its graph", type: "post" });
  });

  it("rejects ciphertext tampering and wrong keys", () => {
    const identity = generateIdentity(); const spaceKey = generateSpaceKey();
    const change = createEncryptedChange({ identity, spaceKey, kind: "social.object.put", payload: { n: 1 } });
    const tail = change.ciphertext.endsWith("A") ? "B" : "A";
    expect(() => verifyEncryptedChange({ ...change, ciphertext: `${change.ciphertext.slice(0, -1)}${tail}` })).toThrow(SyncCoreError);
    expect(() => decryptChange(change, generateSpaceKey())).toThrowError(/Space key/);
  });

  it("orders concurrent branches deterministically and requires ancestry", () => {
    const identity = generateIdentity(); const spaceKey = generateSpaceKey();
    const root = createEncryptedChange({ identity, spaceKey, kind: "social.object.put", payload: { root: true }, createdAt: "2026-08-04T08:00:00.000Z" });
    const left = createEncryptedChange({ identity, spaceKey, kind: "social.object.put", payload: { left: true }, parents: [root.changeId], createdAt: "2026-08-04T08:01:00.000Z" });
    const right = createEncryptedChange({ identity, spaceKey, kind: "social.object.put", payload: { right: true }, parents: [root.changeId], createdAt: "2026-08-04T08:01:00.000Z" });
    expect(orderChangeDag([right, root, left]).map((x) => x.changeId)).toEqual(orderChangeDag([left, right, root]).map((x) => x.changeId));
    expect(() => orderChangeDag([left])).toThrowError(/missing parent or cycle/);
  });
});
