import { describe, expect, it } from "vitest";
import { deriveSpaceId, generateIdentity, generateSpaceKey } from "../src/index.js";
import { KeyManagementError, createDelegationCertificate, generateEncryptionIdentity, unwrapSpaceKey, verifyDelegationCertificate, wrapSpaceKey } from "../src/key-management.js";

describe("device delegation and space-key wrapping", () => {
  it("delegates a bounded device and wraps a space key only to that device", () => {
    const root = generateIdentity(); const device = generateIdentity(); const encryption = generateEncryptionIdentity();
    const certificate = createDelegationCertificate({ root, device, encryption, roles: ["social.write", "node.serve"], notBefore: "2026-08-04T00:00:00.000Z", notAfter: "2027-08-04T00:00:00.000Z", serial: "uAAAAAAAAAAAAAAAAAAAAAA" });
    expect(verifyDelegationCertificate(certificate, new Date("2026-08-05T00:00:00.000Z"))).toBe(true);
    const spaceKey = generateSpaceKey(); const spaceId = deriveSpaceId(spaceKey);
    const wrapped = wrapSpaceKey({ certificate, spaceId, epoch: 1, spaceKey, at: new Date("2026-08-05T00:00:00.000Z"), nonce: new Uint8Array(12).fill(4) });
    expect(unwrapSpaceKey({ wrapped, device, encryption })).toEqual(Buffer.from(spaceKey));
  });

  it("prevents another device from unwrapping and rejects expired delegation", () => {
    const root = generateIdentity(); const device = generateIdentity(); const encryption = generateEncryptionIdentity();
    const certificate = createDelegationCertificate({ root, device, encryption, roles: ["social.write"], notBefore: "2026-08-04T00:00:00.000Z", notAfter: "2026-08-06T00:00:00.000Z" });
    const spaceKey = generateSpaceKey(); const wrapped = wrapSpaceKey({ certificate, spaceId: deriveSpaceId(spaceKey), epoch: 2, spaceKey, at: new Date("2026-08-05T00:00:00.000Z") });
    expect(() => unwrapSpaceKey({ wrapped, device: generateIdentity(), encryption: generateEncryptionIdentity() })).toThrow(KeyManagementError);
    expect(() => verifyDelegationCertificate(certificate, new Date("2026-08-06T00:00:00.000Z"))).toThrowError(/not active/);
  });

  it("detects certificate and wrapped-key tampering", () => {
    const root = generateIdentity(); const device = generateIdentity(); const encryption = generateEncryptionIdentity();
    const certificate = createDelegationCertificate({ root, device, encryption, roles: ["space.admin"], notBefore: "2026-08-04T00:00:00.000Z", notAfter: "2027-08-04T00:00:00.000Z" });
    expect(() => verifyDelegationCertificate({ ...certificate, payload: { ...certificate.payload, roles: ["node.serve"] } }, new Date("2026-08-05T00:00:00.000Z"))).toThrowError(/signature/);
    const spaceKey = generateSpaceKey(); const wrapped = wrapSpaceKey({ certificate, spaceId: deriveSpaceId(spaceKey), epoch: 1, spaceKey, at: new Date("2026-08-05T00:00:00.000Z") });
    expect(() => unwrapSpaceKey({ wrapped: { ...wrapped, ciphertext: `${wrapped.ciphertext.slice(0, -1)}A` }, device, encryption })).toThrowError(/hash mismatch/);
  });
});
