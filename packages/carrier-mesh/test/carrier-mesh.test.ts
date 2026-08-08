import { describe, expect, it } from 'vitest';
import {
  createEncryptedChange,
  deriveSpaceId,
  generateIdentity,
  generateSpaceKey,
  verifyEncryptedChange,
  type DeviceIdentity,
  type EncryptedChange,
} from '@wokenet/sync-core';
import { MemoryChangeStore } from '@wokenet/sync-core/storage';
import {
  createTransportFrame,
  inventoryPayload,
  TransportError,
  type AuthenticatedPeerSession,
} from '@wokenet/sync-core/transport';
import { Carrier, createInMemoryChannelPair, serializeCarrierMessage } from '../src/index.js';

function change(
  identity: DeviceIdentity,
  spaceKey: Uint8Array,
  text: string,
  parents: readonly string[],
  createdAt: string,
): EncryptedChange {
  return createEncryptedChange({
    identity,
    spaceKey,
    kind: 'social.object.put',
    payload: { text },
    parents,
    createdAt,
  });
}

interface TwoNode {
  readonly alice: DeviceIdentity;
  readonly bob: DeviceIdentity;
  readonly spaceKey: Uint8Array;
  readonly spaceId: string;
  readonly aliceStore: MemoryChangeStore;
  readonly bobStore: MemoryChangeStore;
  readonly aliceCarrier: Carrier;
  readonly bobCarrier: Carrier;
  readonly errors: unknown[];
  idle(): Promise<void>;
  /** Inject raw bytes onto Bob's inbound wire, as if Alice had sent them. */
  injectToBob(bytes: Uint8Array): void;
}

function twoNodes(options?: { autoReplicate?: boolean; bobSpaceId?: string }): TwoNode {
  const alice = generateIdentity();
  const bob = generateIdentity();
  const spaceKey = generateSpaceKey();
  const spaceId = deriveSpaceId(spaceKey);
  const aliceStore = new MemoryChangeStore();
  const bobStore = new MemoryChangeStore();
  const pair = createInMemoryChannelPair(alice.id, bob.id);
  const errors: unknown[] = [];
  const shared = {
    autoReplicate: options?.autoReplicate ?? true,
    onError: (error: unknown): void => {
      errors.push(error);
    },
  };
  const aliceCarrier = new Carrier({
    identity: alice,
    spaceId,
    store: aliceStore,
    channel: pair.a,
    ...shared,
  });
  const bobCarrier = new Carrier({
    identity: bob,
    spaceId: options?.bobSpaceId ?? spaceId,
    store: bobStore,
    channel: pair.b,
    ...shared,
  });
  return {
    alice,
    bob,
    spaceKey,
    spaceId,
    aliceStore,
    bobStore,
    aliceCarrier,
    bobCarrier,
    errors,
    idle: () => pair.idle(),
    injectToBob: (bytes: Uint8Array): void => pair.a.send(bob.id, bytes),
  };
}

describe('carrier-mesh 2-node loopback', () => {
  it('authenticates two nodes and replicates encrypted changes both directions', async () => {
    const node = twoNodes();
    const { alice, bob, spaceKey, aliceStore, bobStore } = node;

    const root = change(alice, spaceKey, 'root', [], '2026-08-04T15:00:00.000Z');
    const fromAlice = change(
      alice,
      spaceKey,
      'from-alice',
      [root.changeId],
      '2026-08-04T15:01:00.000Z',
    );
    const fromBob = change(bob, spaceKey, 'from-bob', [root.changeId], '2026-08-04T15:01:00.000Z');

    // Shared root; each node then authors one child the other has never seen.
    aliceStore.putMany([root, fromAlice]);
    bobStore.putMany([root, fromBob]);

    node.aliceCarrier.connect(bob.id);
    await node.idle();

    expect(node.errors).toEqual([]);

    // PRIMARY PROOF: Bob now holds a change he did not author, cryptographically verified.
    const replicatedToBob = bobStore.get(fromAlice.changeId);
    expect(replicatedToBob).not.toBeNull();
    expect(fromAlice.header.author).toBe(alice.id);
    expect(fromAlice.header.author).not.toBe(bob.id);
    expect(verifyEncryptedChange(replicatedToBob as EncryptedChange)).toBe(true);

    // Anti-entropy ran both ways: Alice also received Bob's change.
    expect(aliceStore.get(fromBob.changeId)).not.toBeNull();

    // Convergence: identical verified receipts, count, head/root.
    const aliceReceipt = aliceStore.receipt();
    const bobReceipt = bobStore.receipt();
    expect(bobReceipt).toEqual(aliceReceipt);
    expect(bobReceipt.changeCount).toBe(3);
    expect(bobReceipt.root).toBe(aliceReceipt.root);
    expect(bobReceipt.heads).toEqual([fromAlice.changeId, fromBob.changeId].sort());

    // Idempotent: a second sync round moves nothing.
    node.aliceCarrier.requestSync(bob.id);
    await node.idle();
    expect(bobStore.receipt().changeCount).toBe(3);
    expect(node.errors).toEqual([]);
  });

  it('rejects a handshake for the wrong space', async () => {
    const foreignSpaceId = deriveSpaceId(generateSpaceKey());
    const node = twoNodes({ bobSpaceId: foreignSpaceId });

    node.aliceCarrier.connect(node.bob.id);
    await node.idle();

    expect(node.errors.length).toBeGreaterThan(0);
    const wrongSpace = node.errors.find(
      (error): error is TransportError =>
        error instanceof TransportError && error.code === 'wrong_space',
    );
    expect(wrongSpace).toBeDefined();
    // No session was ever established on the initiator side.
    expect(node.aliceCarrier.session(node.bob.id)).toBeUndefined();
  });

  it('verifies every frame: a tampered frame is rejected before storage', async () => {
    const node = twoNodes({ autoReplicate: false });
    const { alice, bob, spaceKey, aliceStore, bobStore } = node;

    const root = change(alice, spaceKey, 'root', [], '2026-08-04T15:00:00.000Z');
    aliceStore.put(root);
    bobStore.put(root);

    node.aliceCarrier.connect(bob.id);
    await node.idle();
    expect(node.errors).toEqual([]);

    const session = node.aliceCarrier.session(bob.id) as AuthenticatedPeerSession;
    const honest = createTransportFrame({
      session,
      identity: alice,
      sequence: 0,
      payload: inventoryPayload(aliceStore),
    });
    const tampered = { ...honest, payloadHash: `${honest.payloadHash}x` };

    // Inject the forged frame straight onto Bob's inbound wire.
    node.injectToBob(serializeCarrierMessage({ t: 'frame', frame: tampered }));
    await node.idle();

    const tamper = node.errors.find(
      (error): error is TransportError =>
        error instanceof TransportError && error.code === 'payload_tampered',
    );
    expect(tamper).toBeDefined();
    // Bob's store is untouched by the forged frame.
    expect(bobStore.receipt().changeCount).toBe(1);
  });

  it('rejects a frame bound to a different session', async () => {
    const node = twoNodes({ autoReplicate: false });
    const foreign = twoNodes({ autoReplicate: false });

    const root = change(node.alice, node.spaceKey, 'root', [], '2026-08-04T15:00:00.000Z');
    node.aliceStore.put(root);
    node.bobStore.put(root);

    node.aliceCarrier.connect(node.bob.id);
    foreign.aliceCarrier.connect(foreign.bob.id);
    await node.idle();
    await foreign.idle();

    const foreignSession = foreign.aliceCarrier.session(foreign.bob.id) as AuthenticatedPeerSession;
    const foreignFrame = createTransportFrame({
      session: foreignSession,
      identity: foreign.alice,
      sequence: 0,
      payload: inventoryPayload(foreign.aliceStore),
    });

    node.injectToBob(serializeCarrierMessage({ t: 'frame', frame: foreignFrame }));
    await node.idle();

    const mismatch = node.errors.find(
      (error): error is TransportError =>
        error instanceof TransportError && error.code === 'session_mismatch',
    );
    expect(mismatch).toBeDefined();
    expect(node.bobStore.receipt().changeCount).toBe(1);
  });
});
