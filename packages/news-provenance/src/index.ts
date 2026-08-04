import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';

export const NEWS_PROTOCOL = 'wokenet.news.provenance' as const;
export const NEWS_PROTOCOL_VERSION = 1 as const;

export type SourceRiskLabel =
  | 'anonymous-source'
  | 'named-source'
  | 'public-record'
  | 'sensitive-whistleblower'
  | 'unverified-submission';
export type RevisionKind = 'clarification' | 'correction' | 'original' | 'retraction';
export type EditorialRole = 'editor' | 'fact-checker' | 'legal-review' | 'reporter';

export interface EditorialIdentity {
  readonly id: string;
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
}

export interface EvidenceReceipt {
  readonly protocol: typeof NEWS_PROTOCOL;
  readonly version: typeof NEWS_PROTOCOL_VERSION;
  readonly receiptId: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly capturedAt: string;
  readonly sourceRisk: SourceRiskLabel;
}

export interface StoryContent {
  readonly headline: string;
  readonly summary: string;
  readonly body: string;
}

export interface StoryManifestPayload {
  readonly protocol: typeof NEWS_PROTOCOL;
  readonly version: typeof NEWS_PROTOCOL_VERSION;
  readonly revision: number;
  readonly revisionKind: RevisionKind;
  readonly previousStoryId: string | null;
  readonly rootStoryId: string | null;
  readonly correctionNote: string | null;
  readonly publishedAt: string;
  readonly bylines: readonly string[];
  readonly content: StoryContent;
  readonly evidenceReceiptIds: readonly string[];
  readonly sourceRiskLabels: readonly SourceRiskLabel[];
}

export interface StoryManifest extends StoryManifestPayload {
  readonly storyId: string;
}

export interface EditorialSignature {
  readonly protocol: typeof NEWS_PROTOCOL;
  readonly version: typeof NEWS_PROTOCOL_VERSION;
  readonly storyId: string;
  readonly signerId: string;
  readonly role: EditorialRole;
  readonly signedAt: string;
  readonly publicKeyPem: string;
  readonly signature: string;
}

export interface VerifiedStoryHistory {
  readonly rootStoryId: string;
  readonly currentStoryId: string;
  readonly chain: readonly string[];
  readonly evidenceReceiptIds: readonly string[];
  readonly sourceRiskLabels: readonly SourceRiskLabel[];
  readonly signatureCount: number;
  readonly verificationHash: string;
}

export class NewsProvenanceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NewsProvenanceError';
  }
}

const SOURCE_RISKS = new Set<SourceRiskLabel>([
  'anonymous-source',
  'named-source',
  'public-record',
  'sensitive-whistleblower',
  'unverified-submission',
]);
const REVISION_KINDS = new Set<RevisionKind>([
  'clarification',
  'correction',
  'original',
  'retraction',
]);
const EDITORIAL_ROLES = new Set<EditorialRole>([
  'editor',
  'fact-checker',
  'legal-review',
  'reporter',
]);
const ID = /^(?:wokenews|wokeevidence|wokeeditor):v1:u[A-Za-z0-9_-]{43}$/u;
const HASH = /^u[A-Za-z0-9_-]{43}$/u;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u;
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_EVIDENCE_BYTES = 512 * 1024 * 1024;
const EVIDENCE_KEYS = [
  'byteLength',
  'capturedAt',
  'contentHash',
  'mediaType',
  'protocol',
  'receiptId',
  'sourceRisk',
  'version',
];
const CONTENT_KEYS = ['body', 'headline', 'summary'];
const MANIFEST_KEYS = [
  'bylines',
  'content',
  'correctionNote',
  'evidenceReceiptIds',
  'previousStoryId',
  'protocol',
  'publishedAt',
  'revision',
  'revisionKind',
  'rootStoryId',
  'sourceRiskLabels',
  'storyId',
  'version',
];
const SIGNATURE_KEYS = [
  'protocol',
  'publicKeyPem',
  'role',
  'signature',
  'signedAt',
  'signerId',
  'storyId',
  'version',
];

function fail(code: string, message: string): never {
  throw new NewsProvenanceError(code, message);
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail('unsupported_field', `${label} contains a missing or unsupported field.`);
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(',')}}`;
  }
  return fail('invalid_canonical_value', 'Protocol values must be finite canonical JSON.');
}

function hash(bytes: Uint8Array | string): string {
  return `u${createHash('sha256').update(bytes).digest('base64url')}`;
}

function identifier(prefix: 'wokeeditor' | 'wokeevidence' | 'wokenews', value: unknown): string {
  return `${prefix}:v1:${hash(canonicalize(value))}`;
}

function timestamp(value: string, label: string): void {
  if (!UTC_MILLISECONDS.test(value) || !Number.isFinite(Date.parse(value)))
    fail('invalid_time', `${label} must use exact UTC milliseconds.`);
}

function boundedText(value: string, label: string, maximum: number, allowEmpty = false): void {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.trim().length === 0) ||
    Buffer.byteLength(value, 'utf8') > maximum
  )
    fail('invalid_text', `${label} is empty or exceeds its byte limit.`);
}

function sortedUnique<T extends string>(values: readonly T[], label: string): readonly T[] {
  if (!Array.isArray(values) || values.length > 1_000)
    fail('invalid_collection', `${label} must be a bounded array.`);
  const sorted = [...values].sort();
  if (new Set(sorted).size !== sorted.length)
    fail('invalid_collection', `${label} must not contain duplicates.`);
  return Object.freeze(sorted);
}

function normalizedSet<T extends string>(values: readonly T[], label: string): readonly T[] {
  if (!Array.isArray(values) || values.length > 10_000)
    fail('invalid_collection', `${label} must be a bounded array.`);
  return Object.freeze([...new Set(values)].sort());
}

function validateId(value: string, prefix: 'wokeeditor' | 'wokeevidence' | 'wokenews'): void {
  if (!ID.test(value) || !value.startsWith(`${prefix}:`))
    fail('invalid_id', `Expected a ${prefix} v1 identifier.`);
}

function validateStoryPayload(payload: StoryManifestPayload): void {
  if (payload.protocol !== NEWS_PROTOCOL || payload.version !== NEWS_PROTOCOL_VERSION)
    fail('unsupported_protocol', 'Unsupported news provenance protocol.');
  if (!Number.isSafeInteger(payload.revision) || payload.revision < 0)
    fail('invalid_revision', 'Story revision must be a non-negative safe integer.');
  if (!REVISION_KINDS.has(payload.revisionKind))
    fail('invalid_revision_kind', 'Story revision kind is unsupported.');
  timestamp(payload.publishedAt, 'publishedAt');
  boundedText(payload.content.headline, 'headline', 512);
  boundedText(payload.content.summary, 'summary', 4_096, true);
  boundedText(payload.content.body, 'body', 2 * 1024 * 1024);
  const bylines = sortedUnique(payload.bylines, 'bylines');
  if (bylines.length === 0)
    fail('missing_byline', 'At least one public byline identifier is required.');
  for (const byline of bylines) boundedText(byline, 'byline', 256);
  for (const receiptId of sortedUnique(payload.evidenceReceiptIds, 'evidenceReceiptIds'))
    validateId(receiptId, 'wokeevidence');
  for (const label of sortedUnique(payload.sourceRiskLabels, 'sourceRiskLabels'))
    if (!SOURCE_RISKS.has(label)) fail('invalid_source_risk', 'Source-risk label is unsupported.');
  if (payload.revision === 0) {
    if (
      payload.revisionKind !== 'original' ||
      payload.previousStoryId !== null ||
      payload.rootStoryId !== null ||
      payload.correctionNote !== null
    )
      fail(
        'invalid_root',
        'Revision zero must be an original with no predecessor or correction note.',
      );
  } else {
    if (payload.revisionKind === 'original')
      fail('invalid_revision_kind', 'A later revision cannot be original.');
    if (payload.previousStoryId === null || payload.rootStoryId === null)
      fail('missing_predecessor', 'A later revision must identify its root and predecessor.');
    validateId(payload.previousStoryId, 'wokenews');
    validateId(payload.rootStoryId, 'wokenews');
    if (payload.correctionNote === null)
      fail('missing_correction_note', 'A later revision requires a public correction note.');
    boundedText(payload.correctionNote, 'correctionNote', 4_096);
  }
}

export function generateEditorialIdentity(): EditorialIdentity {
  const pair = generateKeyPairSync('ed25519');
  const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' });
  return Object.freeze({
    id: `wokeeditor:v1:${hash(publicDer)}`,
    publicKeyPem,
    privateKeyPem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  });
}

export function createEvidenceReceipt(input: {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly capturedAt: string;
  readonly sourceRisk: SourceRiskLabel;
}): EvidenceReceipt {
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0)
    fail('invalid_evidence', 'Evidence bytes must be non-empty.');
  if (input.bytes.byteLength > MAX_EVIDENCE_BYTES)
    fail('evidence_too_large', 'Evidence receipt input exceeds 512 MiB.');
  if (!MEDIA_TYPE.test(input.mediaType))
    fail('invalid_media_type', 'Evidence media type must be a normalized MIME type.');
  timestamp(input.capturedAt, 'capturedAt');
  if (!SOURCE_RISKS.has(input.sourceRisk))
    fail('invalid_source_risk', 'Source-risk label is unsupported.');
  const descriptor = Object.freeze({
    protocol: NEWS_PROTOCOL,
    version: NEWS_PROTOCOL_VERSION,
    contentHash: hash(input.bytes),
    byteLength: input.bytes.byteLength,
    mediaType: input.mediaType,
    capturedAt: input.capturedAt,
    sourceRisk: input.sourceRisk,
  });
  return Object.freeze({ ...descriptor, receiptId: identifier('wokeevidence', descriptor) });
}

export function verifyEvidenceReceipt(receipt: EvidenceReceipt, bytes?: Uint8Array): true {
  exactKeys(receipt, EVIDENCE_KEYS, 'Evidence receipt');
  if (receipt.protocol !== NEWS_PROTOCOL || receipt.version !== NEWS_PROTOCOL_VERSION)
    fail('unsupported_protocol', 'Unsupported evidence receipt protocol.');
  validateId(receipt.receiptId, 'wokeevidence');
  if (!HASH.test(receipt.contentHash)) fail('invalid_hash', 'Evidence content hash is invalid.');
  if (
    !Number.isSafeInteger(receipt.byteLength) ||
    receipt.byteLength < 1 ||
    receipt.byteLength > MAX_EVIDENCE_BYTES
  )
    fail('invalid_evidence_length', 'Evidence byte length is invalid.');
  if (!MEDIA_TYPE.test(receipt.mediaType))
    fail('invalid_media_type', 'Evidence media type is invalid.');
  timestamp(receipt.capturedAt, 'capturedAt');
  if (!SOURCE_RISKS.has(receipt.sourceRisk))
    fail('invalid_source_risk', 'Source-risk label is unsupported.');
  const descriptor = {
    protocol: receipt.protocol,
    version: receipt.version,
    contentHash: receipt.contentHash,
    byteLength: receipt.byteLength,
    mediaType: receipt.mediaType,
    capturedAt: receipt.capturedAt,
    sourceRisk: receipt.sourceRisk,
  };
  if (identifier('wokeevidence', descriptor) !== receipt.receiptId)
    fail('receipt_tampered', 'Evidence receipt identifier does not match its descriptor.');
  if (
    bytes !== undefined &&
    (bytes.byteLength !== receipt.byteLength || hash(bytes) !== receipt.contentHash)
  )
    fail('evidence_mismatch', 'Evidence bytes do not match the receipt.');
  return true;
}

export function createStoryManifest(
  input: Omit<StoryManifestPayload, 'protocol' | 'version'>,
): StoryManifest {
  const payload: StoryManifestPayload = Object.freeze({
    protocol: NEWS_PROTOCOL,
    version: NEWS_PROTOCOL_VERSION,
    revision: input.revision,
    revisionKind: input.revisionKind,
    previousStoryId: input.previousStoryId,
    rootStoryId: input.rootStoryId,
    correctionNote: input.correctionNote,
    publishedAt: input.publishedAt,
    bylines: sortedUnique(input.bylines, 'bylines'),
    content: Object.freeze({ ...input.content }),
    evidenceReceiptIds: sortedUnique(input.evidenceReceiptIds, 'evidenceReceiptIds'),
    sourceRiskLabels: sortedUnique(input.sourceRiskLabels, 'sourceRiskLabels'),
  });
  validateStoryPayload(payload);
  return Object.freeze({ ...payload, storyId: identifier('wokenews', payload) });
}

export function verifyStoryManifest(manifest: StoryManifest): true {
  exactKeys(manifest, MANIFEST_KEYS, 'Story manifest');
  exactKeys(manifest.content, CONTENT_KEYS, 'Story content');
  validateId(manifest.storyId, 'wokenews');
  const payload: StoryManifestPayload = {
    protocol: manifest.protocol,
    version: manifest.version,
    revision: manifest.revision,
    revisionKind: manifest.revisionKind,
    previousStoryId: manifest.previousStoryId,
    rootStoryId: manifest.rootStoryId,
    correctionNote: manifest.correctionNote,
    publishedAt: manifest.publishedAt,
    bylines: manifest.bylines,
    content: manifest.content,
    evidenceReceiptIds: manifest.evidenceReceiptIds,
    sourceRiskLabels: manifest.sourceRiskLabels,
  };
  validateStoryPayload(payload);
  if (identifier('wokenews', payload) !== manifest.storyId)
    fail('manifest_tampered', 'Story identifier does not match the manifest payload.');
  return true;
}

function signatureDescriptor(
  signature: Omit<EditorialSignature, 'publicKeyPem' | 'signature'>,
): string {
  return canonicalize(signature);
}

export function signStoryManifest(input: {
  readonly manifest: StoryManifest;
  readonly identity: EditorialIdentity;
  readonly role: EditorialRole;
  readonly signedAt: string;
}): EditorialSignature {
  verifyStoryManifest(input.manifest);
  if (!EDITORIAL_ROLES.has(input.role)) fail('invalid_role', 'Editorial role is unsupported.');
  timestamp(input.signedAt, 'signedAt');
  const descriptor = Object.freeze({
    protocol: NEWS_PROTOCOL,
    version: NEWS_PROTOCOL_VERSION,
    storyId: input.manifest.storyId,
    signerId: input.identity.id,
    role: input.role,
    signedAt: input.signedAt,
  });
  const signature = sign(
    null,
    Buffer.from(signatureDescriptor(descriptor)),
    createPrivateKey(input.identity.privateKeyPem),
  ).toString('base64url');
  return Object.freeze({ ...descriptor, publicKeyPem: input.identity.publicKeyPem, signature });
}

export function verifyEditorialSignature(editorialSignature: EditorialSignature): true {
  exactKeys(editorialSignature, SIGNATURE_KEYS, 'Editorial signature');
  if (
    editorialSignature.protocol !== NEWS_PROTOCOL ||
    editorialSignature.version !== NEWS_PROTOCOL_VERSION
  )
    fail('unsupported_protocol', 'Unsupported editorial signature protocol.');
  validateId(editorialSignature.storyId, 'wokenews');
  validateId(editorialSignature.signerId, 'wokeeditor');
  if (!EDITORIAL_ROLES.has(editorialSignature.role))
    fail('invalid_role', 'Editorial role is unsupported.');
  timestamp(editorialSignature.signedAt, 'signedAt');
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey(editorialSignature.publicKeyPem);
  } catch {
    return fail('invalid_public_key', 'Editorial public key is invalid.');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519')
    fail('invalid_public_key', 'Editorial signatures require an Ed25519 public key.');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' });
  if (`wokeeditor:v1:${hash(publicDer)}` !== editorialSignature.signerId)
    fail('signer_mismatch', 'Editorial public key does not match signer ID.');
  const { signature } = editorialSignature;
  const descriptor = {
    protocol: editorialSignature.protocol,
    version: editorialSignature.version,
    storyId: editorialSignature.storyId,
    signerId: editorialSignature.signerId,
    role: editorialSignature.role,
    signedAt: editorialSignature.signedAt,
  };
  let signatureBytes: Buffer;
  try {
    if (!/^[A-Za-z0-9_-]{86}$/u.test(signature))
      fail('invalid_signature', 'Editorial signature encoding is invalid.');
    signatureBytes = Buffer.from(signature, 'base64url');
  } catch {
    return fail('invalid_signature', 'Editorial signature encoding is invalid.');
  }
  if (
    signatureBytes.length !== 64 ||
    !verify(null, Buffer.from(signatureDescriptor(descriptor)), publicKey, signatureBytes)
  )
    fail('invalid_signature', 'Editorial signature is invalid.');
  return true;
}

export function verifyStoryHistory(input: {
  readonly manifests: readonly StoryManifest[];
  readonly evidenceReceipts: readonly EvidenceReceipt[];
  readonly signatures: readonly EditorialSignature[];
}): VerifiedStoryHistory {
  if (input.manifests.length === 0 || input.manifests.length > 10_000)
    fail('invalid_history', 'Story history must contain between one and 10,000 revisions.');
  const manifestById = new Map<string, StoryManifest>();
  for (const manifest of input.manifests) {
    verifyStoryManifest(manifest);
    if (manifestById.has(manifest.storyId))
      fail('duplicate_manifest', 'Story history repeats a manifest.');
    manifestById.set(manifest.storyId, manifest);
  }
  const roots = input.manifests.filter((manifest) => manifest.revision === 0);
  if (roots.length !== 1) fail('invalid_history_root', 'Story history must have exactly one root.');
  const root = roots[0];
  if (root === undefined) return fail('invalid_history_root', 'Story history has no root.');
  const chain: StoryManifest[] = [root];
  while (chain.length < input.manifests.length) {
    const previous = chain.at(-1);
    if (previous === undefined) return fail('invalid_history', 'Story history is empty.');
    const children = input.manifests.filter(
      (manifest) => manifest.previousStoryId === previous.storyId,
    );
    if (children.length !== 1)
      fail('forked_history', 'Correction history must be one complete linear chain.');
    const child = children[0];
    if (child === undefined) return fail('invalid_history', 'Correction history is incomplete.');
    if (
      child.revision !== previous.revision + 1 ||
      child.rootStoryId !== root.storyId ||
      Date.parse(child.publishedAt) < Date.parse(previous.publishedAt)
    )
      fail(
        'invalid_correction_link',
        'Correction revision, root, or publication order is invalid.',
      );
    chain.push(child);
  }

  const evidenceById = new Map<string, EvidenceReceipt>();
  for (const receipt of input.evidenceReceipts) {
    verifyEvidenceReceipt(receipt);
    if (evidenceById.has(receipt.receiptId))
      fail('duplicate_receipt', 'Evidence list repeats a receipt.');
    evidenceById.set(receipt.receiptId, receipt);
  }
  const referencedEvidence = normalizedSet(
    chain.flatMap((manifest) => [...manifest.evidenceReceiptIds]),
    'referenced evidence',
  );
  for (const receiptId of referencedEvidence)
    if (!evidenceById.has(receiptId))
      fail('missing_evidence_receipt', 'A story references a missing evidence receipt.');
  for (const receiptId of evidenceById.keys())
    if (!referencedEvidence.includes(receiptId))
      fail('orphan_evidence_receipt', 'An evidence receipt is not referenced by this history.');
  for (const manifest of chain) {
    const declaredRisks = new Set(manifest.sourceRiskLabels);
    for (const receiptId of manifest.evidenceReceiptIds) {
      const receipt = evidenceById.get(receiptId);
      if (receipt !== undefined && !declaredRisks.has(receipt.sourceRisk))
        fail(
          'source_risk_mismatch',
          'A story must disclose the source-risk label of every linked evidence receipt.',
        );
    }
  }

  const signaturesByStory = new Map<string, Set<string>>();
  for (const editorialSignature of input.signatures) {
    verifyEditorialSignature(editorialSignature);
    if (!manifestById.has(editorialSignature.storyId))
      fail('orphan_signature', 'An editorial signature references a story outside this history.');
    const signers = signaturesByStory.get(editorialSignature.storyId) ?? new Set<string>();
    if (signers.has(editorialSignature.signerId))
      fail('duplicate_signature', 'A signer may attest to a story revision only once.');
    signers.add(editorialSignature.signerId);
    signaturesByStory.set(editorialSignature.storyId, signers);
  }
  for (const manifest of chain)
    if ((signaturesByStory.get(manifest.storyId)?.size ?? 0) === 0)
      fail('unsigned_revision', 'Every story revision requires at least one editorial signature.');

  const sourceRiskLabels = normalizedSet(
    chain.flatMap((manifest) => [...manifest.sourceRiskLabels]),
    'source-risk labels',
  );
  const chainIds = Object.freeze(chain.map((manifest) => manifest.storyId));
  const verificationDescriptor = {
    chain: chainIds,
    evidenceReceiptIds: referencedEvidence,
    signatures: [...input.signatures]
      .map((signature) => ({
        protocol: signature.protocol,
        version: signature.version,
        storyId: signature.storyId,
        signerId: signature.signerId,
        role: signature.role,
        signedAt: signature.signedAt,
        signature: signature.signature,
      }))
      .sort((left, right) =>
        `${left.storyId}:${left.signerId}`.localeCompare(`${right.storyId}:${right.signerId}`),
      ),
  };
  return Object.freeze({
    rootStoryId: root.storyId,
    currentStoryId: chain.at(-1)?.storyId ?? root.storyId,
    chain: chainIds,
    evidenceReceiptIds: referencedEvidence,
    sourceRiskLabels,
    signatureCount: input.signatures.length,
    verificationHash: hash(canonicalize(verificationDescriptor)),
  });
}
