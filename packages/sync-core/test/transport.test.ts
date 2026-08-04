import { describe, expect, it } from 'vitest';
import {
  createEncryptedChange,
  deriveSpaceId,
  generateIdentity,
  generateSpaceKey,
} from '../src/index.js';
import { MemoryChangeStore } from '../src/storage.js';
import {
  HandshakeReplayWindow,
  PeerFrameReceiver,
  TransportError,
  acceptPeerChallenge,
  acceptPeerHello,
  applyChangesPayload,
  changesPayload,
  createPeerHello,
  createTransportFrame,
  finalizePeerHandshake,
  inventoryPayload,
  wantedPayload,
} from '../src/transport.js';

const NOW = new Date('2026-08-04T16:00:00.000Z');

function handshake() {
  const initiator = generateIdentity();
  const responder = generateIdentity();
  const spaceKey = generateSpaceKey();
  const spaceId = deriveSpaceId(spaceKey);
  const hello = createPeerHello({
    identity: initiator,
    spaceId,
    createdAt: NOW.toISOString(),
    nonce: new Uint8Array(32).fill(1),
  });
  const challenge = acceptPeerHello({
    hello,
    responder,
    expectedSpaceId: spaceId,
    replayWindow: new HandshakeReplayWindow(),
    now: NOW,
    createdAt: NOW.toISOString(),
    nonce: new Uint8Array(32).fill(2),
  });
  const accepted = acceptPeerChallenge({
    hello,
    challenge,
    initiator,
    replayWindow: new HandshakeReplayWindow(),
    now: NOW,
  });
  const finalized = finalizePeerHandshake({
    hello,
    challenge,
    ack: accepted.ack,
    responder,
    now: NOW,
  });
  expect(finalized).toEqual(accepted.session);
  return { initiator, responder, spaceKey, session: finalized };
}

describe('authenticated peer transport', () => {
  it('mutually authenticates peers and converges concurrent encrypted DAG branches', () => {
    const { initiator, responder, spaceKey, session } = handshake();
    const root = createEncryptedChange({
      identity: initiator,
      spaceKey,
      kind: 'social.object.put',
      payload: { text: 'root' },
      createdAt: '2026-08-04T15:00:00.000Z',
    });
    const left = createEncryptedChange({
      identity: initiator,
      spaceKey,
      kind: 'social.object.put',
      payload: { text: 'left' },
      parents: [root.changeId],
      createdAt: '2026-08-04T15:01:00.000Z',
    });
    const right = createEncryptedChange({
      identity: responder,
      spaceKey,
      kind: 'social.object.put',
      payload: { text: 'right' },
      parents: [root.changeId],
      createdAt: '2026-08-04T15:01:00.000Z',
    });
    const leftStore = new MemoryChangeStore();
    const rightStore = new MemoryChangeStore();
    leftStore.putMany([root, left]);
    rightStore.putMany([root, right]);

    const leftReceiver = new PeerFrameReceiver(session, responder.id);
    const rightReceiver = new PeerFrameReceiver(session, initiator.id);
    const leftInventory = rightReceiver.accept(
      createTransportFrame({
        session,
        identity: initiator,
        sequence: 0,
        payload: inventoryPayload(leftStore),
      }),
    );
    const rightWant = leftReceiver.accept(
      createTransportFrame({
        session,
        identity: responder,
        sequence: 0,
        payload: wantedPayload(rightStore, leftInventory),
      }),
    );
    const leftChanges = rightReceiver.accept(
      createTransportFrame({
        session,
        identity: initiator,
        sequence: 1,
        payload: changesPayload(leftStore, rightWant),
      }),
    );
    expect(applyChangesPayload(rightStore, leftChanges)).toBe(1);

    const rightInventory = leftReceiver.accept(
      createTransportFrame({
        session,
        identity: responder,
        sequence: 1,
        payload: inventoryPayload(rightStore),
      }),
    );
    const leftWant = rightReceiver.accept(
      createTransportFrame({
        session,
        identity: initiator,
        sequence: 2,
        payload: wantedPayload(leftStore, rightInventory),
      }),
    );
    const rightChanges = leftReceiver.accept(
      createTransportFrame({
        session,
        identity: responder,
        sequence: 2,
        payload: changesPayload(rightStore, leftWant),
      }),
    );
    expect(applyChangesPayload(leftStore, rightChanges)).toBe(1);
    expect(leftStore.receipt()).toEqual(rightStore.receipt());
    expect(leftStore.receipt().changeCount).toBe(3);
    expect(applyChangesPayload(leftStore, rightChanges)).toBe(0);
  });

  it('rejects replayed handshakes, wrong spaces, and tampered challenges', () => {
    const initiator = generateIdentity();
    const responder = generateIdentity();
    const spaceId = deriveSpaceId(generateSpaceKey());
    const hello = createPeerHello({
      identity: initiator,
      spaceId,
      createdAt: NOW.toISOString(),
      nonce: new Uint8Array(32).fill(3),
    });
    const replayWindow = new HandshakeReplayWindow();
    const challenge = acceptPeerHello({
      hello,
      responder,
      expectedSpaceId: spaceId,
      replayWindow,
      now: NOW,
    });
    expect(() =>
      acceptPeerHello({ hello, responder, expectedSpaceId: spaceId, replayWindow, now: NOW }),
    ).toThrowError(expect.objectContaining({ code: 'handshake_replay' }));
    expect(() =>
      acceptPeerHello({
        hello,
        responder,
        expectedSpaceId: deriveSpaceId(generateSpaceKey()),
        replayWindow: new HandshakeReplayWindow(),
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: 'wrong_space' }));
    expect(() =>
      acceptPeerChallenge({
        hello,
        challenge: {
          ...challenge,
          signature: `${challenge.signature[0]}${challenge.signature[1] === 'A' ? 'B' : 'A'}${challenge.signature.slice(2)}`,
        },
        initiator,
        replayWindow: new HandshakeReplayWindow(),
        now: NOW,
      }),
    ).toThrow(TransportError);
  });

  it('rejects replayed, out-of-order, and tampered signed frames', () => {
    const { initiator, responder, session } = handshake();
    const receiver = new PeerFrameReceiver(session, initiator.id);
    const frame = createTransportFrame({
      session,
      identity: initiator,
      sequence: 0,
      payload: { kind: 'inventory', changeIds: [] },
    });
    expect(receiver.accept(frame)).toEqual({ kind: 'inventory', changeIds: [] });
    expect(() => receiver.accept(frame)).toThrowError(
      expect.objectContaining({ code: 'sequence_mismatch' }),
    );
    const nextFrame = createTransportFrame({
      session,
      identity: initiator,
      sequence: 1,
      payload: { kind: 'inventory', changeIds: [] },
    });
    expect(() =>
      receiver.accept({
        ...nextFrame,
        payload: { kind: 'want', changeIds: [] },
      }),
    ).toThrowError(expect.objectContaining({ code: 'payload_mismatch' }));
    expect(() =>
      new PeerFrameReceiver(session, responder.id).accept(
        createTransportFrame({
          session,
          identity: responder,
          sequence: 2,
          payload: { kind: 'inventory', changeIds: [] },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'sequence_mismatch' }));
  });

  it('rejects change batches with incomplete ancestry', () => {
    const identity = generateIdentity();
    const spaceKey = generateSpaceKey();
    const root = createEncryptedChange({
      identity,
      spaceKey,
      kind: 'social.object.put',
      payload: { root: true },
    });
    const child = createEncryptedChange({
      identity,
      spaceKey,
      kind: 'social.object.put',
      payload: { child: true },
      parents: [root.changeId],
    });
    expect(() =>
      applyChangesPayload(new MemoryChangeStore(), { kind: 'changes', changes: [child] }),
    ).toThrowError(expect.objectContaining({ code: 'missing_or_cyclic_parent' }));

    const otherSpaceChange = createEncryptedChange({
      identity,
      spaceKey: generateSpaceKey(),
      kind: 'social.object.put',
      payload: { other: true },
    });
    const rootedStore = new MemoryChangeStore();
    rootedStore.put(root);
    expect(() =>
      applyChangesPayload(rootedStore, { kind: 'changes', changes: [otherSpaceChange] }),
    ).toThrowError(expect.objectContaining({ code: 'wrong_space' }));
  });
});
