import { describe, expect, it } from "vitest";
import { generateIdentity } from "../src/index.js";
import { SocialCrdtError, createSocialOperation, materializeSocialState, validateSocialOperation } from "../src/social-crdt.js";

describe("social CRDT materialization", () => {
  it("preserves concurrent profile fields and converges regardless of delivery order", () => {
    const alex = generateIdentity(); const phone = generateIdentity();
    const name = createSocialOperation({ actor: alex.id, sequence: 1, createdAt: "2026-08-04T09:00:00.000Z", type: "profile.field.set", objectId: "profile:alex", payload: { field: "displayName", value: "Alex Droolhouse" } });
    const bio = createSocialOperation({ actor: phone.id, sequence: 1, createdAt: "2026-08-04T09:00:01.000Z", type: "profile.field.set", objectId: "profile:alex", payload: { field: "bio", value: "Independent social music." } });
    const first = materializeSocialState([name, bio]); const second = materializeSocialState([bio, name]);
    expect(first).toEqual(second);
    expect(first.profiles["profile:alex"]).toEqual({ bio: "Independent social music.", displayName: "Alex Droolhouse" });
  });

  it("uses observed-remove semantics so an unseen concurrent follow survives", () => {
    const a = generateIdentity(); const b = generateIdentity();
    const firstAdd = createSocialOperation({ actor: a.id, sequence: 1, type: "edge.add", objectId: "profile:alex", payload: { edge: "follow", subject: "profile:alex", target: "profile:drooly", value: null } });
    const concurrentAdd = createSocialOperation({ actor: b.id, sequence: 1, type: "edge.add", objectId: "profile:alex", payload: { edge: "follow", subject: "profile:alex", target: "profile:drooly", value: null } });
    const remove = createSocialOperation({ actor: a.id, sequence: 2, type: "edge.remove", objectId: "profile:alex", payload: { edge: "follow", subject: "profile:alex", target: "profile:drooly", observedAddIds: [firstAdd.opId] } });
    const state = materializeSocialState([remove, concurrentAdd, firstAdd]);
    expect(state.edges).toHaveLength(1);
    expect(state.edges[0]?.addId).toBe(concurrentAdd.opId);
  });

  it("materializes block edits and deletions deterministically", () => {
    const actor = generateIdentity();
    const title = createSocialOperation({ actor: actor.id, sequence: 1, type: "post.block.set", objectId: "post:single", payload: { blockId: "title", after: null, kind: "text", value: "JUMPED THE FENCE" } });
    const body = createSocialOperation({ actor: actor.id, sequence: 2, type: "post.block.set", objectId: "post:single", payload: { blockId: "body", after: "title", kind: "text", value: "Song is live." } });
    const removeBody = createSocialOperation({ actor: actor.id, sequence: 3, type: "post.block.delete", objectId: "post:single", payload: { blockId: "body" } });
    expect(materializeSocialState([removeBody, body, title]).posts["post:single"]?.blocks).toEqual([{ id: "title", kind: "text", value: "JUMPED THE FENCE" }]);
  });

  it("rejects tampered operations and oversized content", () => {
    const actor = generateIdentity();
    const operation = createSocialOperation({ actor: actor.id, sequence: 1, type: "profile.field.set", objectId: "profile:alex", payload: { field: "handle", value: "kingofqueens6ix" } });
    expect(() => validateSocialOperation({ ...operation, sequence: 2 })).toThrow(SocialCrdtError);
    expect(() => createSocialOperation({ actor: actor.id, sequence: 2, type: "profile.field.set", objectId: "profile:alex", payload: { field: "bio", value: "x".repeat(2_001) } })).toThrow(SocialCrdtError);
  });
});
