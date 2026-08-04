# @wokenet/news-provenance

Deterministic integrity and correction receipts for independently distributed journalism.

This research package models five narrow guarantees:

- content-addressed story manifests;
- evidence receipts that contain a SHA-256 hash and bounded metadata, never evidence bytes or source secrets;
- a linear, append-only correction / clarification / retraction chain;
- Ed25519 editorial signatures bound to a story revision, role, and timestamp;
- explicit source-risk labels and a reproducible history verification receipt.

Status: implemented and independently testable research package. It is not a newsroom, source vault, whistleblower drop box, identity authority, relay network, or production deployment.

## Usage

```ts
import {
  createEvidenceReceipt,
  createStoryManifest,
  generateEditorialIdentity,
  signStoryManifest,
  verifyStoryHistory,
} from '@wokenet/news-provenance';

const editor = generateEditorialIdentity();
const evidence = createEvidenceReceipt({
  bytes: fileBytes,
  mediaType: 'application/pdf',
  capturedAt: '2026-08-04T12:00:00.000Z',
  sourceRisk: 'sensitive-whistleblower',
});

const story = createStoryManifest({
  revision: 0,
  revisionKind: 'original',
  previousStoryId: null,
  rootStoryId: null,
  correctionNote: null,
  publishedAt: '2026-08-04T13:00:00.000Z',
  bylines: ['reporter:public-handle'],
  content: { headline: 'Example', summary: 'Example only.', body: 'Public story copy.' },
  evidenceReceiptIds: [evidence.receiptId],
  sourceRiskLabels: ['sensitive-whistleblower'],
});

const editorialSignature = signStoryManifest({
  manifest: story,
  identity: editor,
  role: 'editor',
  signedAt: '2026-08-04T13:01:00.000Z',
});

const result = verifyStoryHistory({
  manifests: [story],
  evidenceReceipts: [evidence],
  signatures: [editorialSignature],
});
```

The caller should persist the raw evidence in a separately encrypted, access-controlled source vault. Only the receipt is suitable for public distribution.

## Determinism

Set-like fields are normalized lexicographically before hashing. IDs use SHA-256 over canonical JSON and base64url multibase encoding. History verification reconstructs the correction chain from links, verifies every receipt and signature, and hashes an order-normalized verification descriptor. Equivalent inputs produce the same receipt regardless of array arrival order.

Run the package in isolation:

```bash
pnpm --filter @wokenet/news-provenance typecheck
pnpm --filter @wokenet/news-provenance test
pnpm --filter @wokenet/news-provenance build
```

## Threat boundaries

The protocol detects changed manifests, changed evidence bytes, forged editorial attestations, missing or orphaned receipts, undisclosed source-risk label mismatches, unsigned revisions, incomplete histories, correction forks, and undeclared extension fields.

It does **not** prove that:

- a story or source is truthful;
- a timestamp was issued by a trusted clock;
- evidence was obtained lawfully or ethically;
- the same evidence has not been selectively edited before hashing;
- an editorial private key was not stolen;
- a publisher supplied every known correction or every relevant piece of evidence;
- a source is anonymous against endpoint compromise, traffic analysis, browser telemetry, or newsroom operational mistakes.

Public risk labels reveal that a story used a class of source. They intentionally do not identify that source. Deployments need a dedicated E2EE submission channel, audited key custody, access logging, metadata minimization, malware isolation, key rotation / revocation, secure deletion policy, and trained human editorial review. Do not place source names, contact details, original filenames, access tokens, or decryption keys in story manifests or evidence receipts.
