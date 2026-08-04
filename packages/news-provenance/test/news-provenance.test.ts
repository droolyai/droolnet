import { describe, expect, it } from 'vitest';
import {
  NewsProvenanceError,
  createEvidenceReceipt,
  createStoryManifest,
  generateEditorialIdentity,
  signStoryManifest,
  verifyEditorialSignature,
  verifyEvidenceReceipt,
  verifyStoryHistory,
  verifyStoryManifest,
} from '../src/index.js';

const FIRST_PUBLISHED = '2026-08-04T12:00:00.000Z';
const SECOND_PUBLISHED = '2026-08-04T13:00:00.000Z';
const EVIDENCE_BYTES = new TextEncoder().encode('synthetic public-record fixture');

function fixture() {
  const reporter = generateEditorialIdentity();
  const editor = generateEditorialIdentity();
  const evidence = createEvidenceReceipt({
    bytes: EVIDENCE_BYTES,
    mediaType: 'text/plain',
    capturedAt: '2026-08-04T11:30:00.000Z',
    sourceRisk: 'public-record',
  });
  const original = createStoryManifest({
    revision: 0,
    revisionKind: 'original',
    previousStoryId: null,
    rootStoryId: null,
    correctionNote: null,
    publishedAt: FIRST_PUBLISHED,
    bylines: ['reporter:fixture'],
    content: {
      headline: 'Protocol fixture headline',
      summary: 'Synthetic test data only.',
      body: 'This is not a claim about a real person or event.',
    },
    evidenceReceiptIds: [evidence.receiptId],
    sourceRiskLabels: ['public-record'],
  });
  const correction = createStoryManifest({
    revision: 1,
    revisionKind: 'correction',
    previousStoryId: original.storyId,
    rootStoryId: original.storyId,
    correctionNote: 'Corrected the synthetic fixture wording.',
    publishedAt: SECOND_PUBLISHED,
    bylines: ['reporter:fixture'],
    content: {
      headline: 'Protocol fixture headline',
      summary: 'Corrected synthetic test data only.',
      body: 'This corrected fixture still makes no claim about a real person or event.',
    },
    evidenceReceiptIds: [evidence.receiptId],
    sourceRiskLabels: ['public-record'],
  });
  const signatures = [
    signStoryManifest({
      manifest: original,
      identity: reporter,
      role: 'reporter',
      signedAt: FIRST_PUBLISHED,
    }),
    signStoryManifest({
      manifest: correction,
      identity: editor,
      role: 'editor',
      signedAt: SECOND_PUBLISHED,
    }),
  ] as const;
  return { reporter, editor, evidence, original, correction, signatures };
}

describe('evidence receipts', () => {
  it('records only a content hash and bounded metadata, then verifies supplied bytes', () => {
    const { evidence } = fixture();
    expect(verifyEvidenceReceipt(evidence, EVIDENCE_BYTES)).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain('synthetic public-record fixture');
    expect(evidence.receiptId).toMatch(/^wokeevidence:v1:u[A-Za-z0-9_-]{43}$/u);
  });

  it('rejects changed evidence and receipt metadata', () => {
    const { evidence } = fixture();
    expect(() => verifyEvidenceReceipt(evidence, new TextEncoder().encode('changed'))).toThrowError(
      expect.objectContaining({ code: 'evidence_mismatch' }),
    );
    expect(() =>
      verifyEvidenceReceipt({ ...evidence, byteLength: evidence.byteLength + 1 }),
    ).toThrowError(expect.objectContaining({ code: 'receipt_tampered' }));
    expect(() =>
      verifyEvidenceReceipt({ ...evidence, sourceName: 'must-never-appear' } as typeof evidence),
    ).toThrowError(expect.objectContaining({ code: 'unsupported_field' }));
  });
});

describe('content-addressed stories and editorial signatures', () => {
  it('produces stable IDs despite set-like input ordering', () => {
    const input = {
      revision: 0 as const,
      revisionKind: 'original' as const,
      previousStoryId: null,
      rootStoryId: null,
      correctionNote: null,
      publishedAt: FIRST_PUBLISHED,
      content: { headline: 'Fixture', summary: '', body: 'Synthetic body.' },
    };
    const left = createStoryManifest({
      ...input,
      bylines: ['b:two', 'a:one'],
      evidenceReceiptIds: [],
      sourceRiskLabels: ['public-record', 'named-source'],
    });
    const right = createStoryManifest({
      ...input,
      bylines: ['a:one', 'b:two'],
      evidenceReceiptIds: [],
      sourceRiskLabels: ['named-source', 'public-record'],
    });
    expect(left).toEqual(right);
    expect(verifyStoryManifest(left)).toBe(true);
  });

  it('binds editorial identity, role, timestamp, and story ID', () => {
    const { signatures } = fixture();
    expect(verifyEditorialSignature(signatures[0])).toBe(true);
    expect(() => verifyEditorialSignature({ ...signatures[0], role: 'editor' })).toThrowError(
      expect.objectContaining({ code: 'invalid_signature' }),
    );
  });

  it('rejects manifest tampering', () => {
    const { original } = fixture();
    expect(() =>
      verifyStoryManifest({ ...original, content: { ...original.content, headline: 'Changed' } }),
    ).toThrowError(expect.objectContaining({ code: 'manifest_tampered' }));
  });
});

describe('correction chains', () => {
  it('verifies a complete chain deterministically regardless of input order', () => {
    const { evidence, original, correction, signatures } = fixture();
    const left = verifyStoryHistory({
      manifests: [correction, original],
      evidenceReceipts: [evidence],
      signatures: [...signatures].reverse(),
    });
    const right = verifyStoryHistory({
      manifests: [original, correction],
      evidenceReceipts: [evidence],
      signatures,
    });
    expect(left).toEqual(right);
    expect(left.chain).toEqual([original.storyId, correction.storyId]);
    expect(left.currentStoryId).toBe(correction.storyId);
    expect(left.verificationHash).toMatch(/^u[A-Za-z0-9_-]{43}$/u);
  });

  it('rejects missing receipts, unsigned revisions, and correction forks', () => {
    const { evidence, original, correction, signatures, editor } = fixture();
    expect(() =>
      verifyStoryHistory({ manifests: [original, correction], evidenceReceipts: [], signatures }),
    ).toThrowError(expect.objectContaining({ code: 'missing_evidence_receipt' }));
    expect(() =>
      verifyStoryHistory({
        manifests: [original, correction],
        evidenceReceipts: [evidence],
        signatures: [signatures[0]],
      }),
    ).toThrowError(expect.objectContaining({ code: 'unsigned_revision' }));
    const fork = createStoryManifest({
      ...correction,
      revisionKind: 'clarification',
      correctionNote: 'A separate synthetic branch.',
      content: { ...correction.content, summary: 'Fork fixture.' },
    });
    const forkSignature = signStoryManifest({
      manifest: fork,
      identity: editor,
      role: 'editor',
      signedAt: SECOND_PUBLISHED,
    });
    expect(() =>
      verifyStoryHistory({
        manifests: [original, correction, fork],
        evidenceReceipts: [evidence],
        signatures: [...signatures, forkSignature],
      }),
    ).toThrowError(expect.objectContaining({ code: 'forked_history' }));
  });

  it('rejects orphan receipts and source-risk disclosure mismatches', () => {
    const { evidence, original, signatures } = fixture();
    const orphan = createEvidenceReceipt({
      bytes: new TextEncoder().encode('unreferenced fixture'),
      mediaType: 'text/plain',
      capturedAt: '2026-08-04T11:40:00.000Z',
      sourceRisk: 'named-source',
    });
    expect(() =>
      verifyStoryHistory({
        manifests: [original],
        evidenceReceipts: [evidence, orphan],
        signatures: [signatures[0]],
      }),
    ).toThrowError(expect.objectContaining({ code: 'orphan_evidence_receipt' }));
    const mislabeled = createStoryManifest({
      ...original,
      sourceRiskLabels: ['named-source'],
    });
    const editor = generateEditorialIdentity();
    const signature = signStoryManifest({
      manifest: mislabeled,
      identity: editor,
      role: 'editor',
      signedAt: FIRST_PUBLISHED,
    });
    expect(() =>
      verifyStoryHistory({
        manifests: [mislabeled],
        evidenceReceipts: [evidence],
        signatures: [signature],
      }),
    ).toThrowError(expect.objectContaining({ code: 'source_risk_mismatch' }));
  });

  it('uses typed protocol errors', () => {
    const { original } = fixture();
    expect(() =>
      verifyStoryHistory({ manifests: [original], evidenceReceipts: [], signatures: [] }),
    ).toThrow(NewsProvenanceError);
  });
});
