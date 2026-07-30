/**
 * Deterministic corpus generation for middle-out.
 *
 * Every generator here is pure: the same arguments produce byte-identical output on every run,
 * platform and Node version. That reproducibility is the whole point — a benchmark nobody else
 * can regenerate is not evidence. Two consequences show up in the code below:
 *   - the PRNG is inline (splitmix32, fixed seeds) instead of `Math.random`/`node:crypto`;
 *   - the base58/base64url/base32 encoders are inline instead of imported, so no dependency
 *     upgrade can silently change the published corpus bytes.
 */

/** Fixed seeds. These are part of the public corpus identity: changing one changes the bytes. */
export const CORPUS_SEEDS = {
  mediaManifest: 0x4d414e49,
  protocol: 0x574f4b45,
  videoSegments: 0x56494445,
} as const;

/**
 * Fixed clock origin for generated timestamps: 2026-01-01T00:00:00.000Z.
 * A literal, not `Date.UTC(...)`, so the corpus cannot drift with the host clock or timezone.
 */
const EPOCH_ORIGIN_MS = 1767225600000;

type Rng = () => number;

/** splitmix32. `Math.imul` keeps the multiply exactly 32-bit on every engine. */
function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad) >>> 0;
    mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97) >>> 0;
    return (mixed ^ (mixed >>> 15)) >>> 0;
  };
}

/** Uniform-enough integer in [min, maxExclusive). */
function rangeInt(rng: Rng, min: number, maxExclusive: number): number {
  return min + (rng() % (maxExclusive - min));
}

function pick<T>(table: readonly T[], draw: number): T {
  const value = table[draw % table.length];
  if (value === undefined) {
    // Unreachable for the fixed tables in this file; `noUncheckedIndexedAccess` still needs it.
    throw new Error('corpus: pick() called on an empty table');
  }
  return value;
}

/**
 * High-entropy bytes. Writes past the end of a `Uint8Array` are silently dropped by the spec,
 * so the four-at-a-time loop needs no tail special case.
 */
function randomBytes(rng: Rng, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 4) {
    const word = rng();
    out[i] = word & 0xff;
    out[i + 1] = (word >>> 8) & 0xff;
    out[i + 2] = (word >>> 16) & 0xff;
    out[i + 3] = (word >>> 24) & 0xff;
  }
  return out;
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE32_LOWER_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** base58btc, as used for WokeNet 32-byte ed25519 public keys (44 characters). */
function encodeBase58(bytes: Uint8Array): string {
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      const value = (digits[i] ?? 0) * 256 + carry;
      digits[i] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leading = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    leading += '1';
  }
  let body = '';
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    body += BASE58_ALPHABET.charAt(digits[i] ?? 0);
  }
  return leading + body;
}

/** Generic unpadded base-2^k encoder shared by base64url and base32. */
function encodeBaseN(bytes: Uint8Array, alphabet: string, bitsPerChar: number): string {
  let out = '';
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= bitsPerChar) {
      bits -= bitsPerChar;
      out += alphabet.charAt((accumulator >>> bits) & ((1 << bitsPerChar) - 1));
    }
  }
  if (bits > 0) {
    out += alphabet.charAt((accumulator << (bitsPerChar - bits)) & ((1 << bitsPerChar) - 1));
  }
  return out;
}

function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBaseN(bytes, BASE64URL_ALPHABET, 6);
}

function encodeBase32Lower(bytes: Uint8Array): string {
  return encodeBaseN(bytes, BASE32_LOWER_ALPHABET, 5);
}

/** multibase 'u' + unpadded base64url. 32 bytes -> 44 characters. */
function multibaseDigest(digest: Uint8Array): string {
  return `u${encodeBase64Url(digest)}`;
}

/**
 * CIDv1, raw codec (0x55), sha2-256 (0x12) with 32-byte length, multibase base32-lower ('b').
 * Renders as the familiar 59-character `bafkrei…` string.
 */
function cidV1Raw(digest: Uint8Array): string {
  const framed = new Uint8Array(4 + digest.length);
  framed[0] = 0x01;
  framed[1] = 0x55;
  framed[2] = 0x12;
  framed[3] = digest.length;
  framed.set(digest, 4);
  return `b${encodeBase32Lower(framed)}`;
}

function randomCid(rng: Rng): string {
  return cidV1Raw(randomBytes(rng, 32));
}

function randomDigest(rng: Rng): string {
  return multibaseDigest(randomBytes(rng, 32));
}

function randomPublicKey(rng: Rng): string {
  return encodeBase58(randomBytes(rng, 32));
}

/** 64-byte ed25519 signature as multibase base64url: 'u' + 86 characters. */
function randomSignature(rng: Rng): string {
  return `u${encodeBase64Url(randomBytes(rng, 64))}`;
}

/**
 * Composite WokeNet identity id: 160 characters of pure encoded randomness.
 * `woke:id:v1:<base58 key>:<content CID>:<multibase digest>`
 */
function identityId(rng: Rng): string {
  return ['woke', 'id', 'v1', randomPublicKey(rng), randomCid(rng), randomDigest(rng)].join(':');
}

/** Composite signing-key id: `woke:key:v1:ed25519:<base58 key>:<multibase digest>`. */
function signingKeyId(rng: Rng): string {
  return ['woke', 'key', 'v1', 'ed25519', randomPublicKey(rng), randomDigest(rng)].join(':');
}

/** Exact-millisecond ISO-8601, e.g. `2026-03-14T08:22:41.317Z`. */
function timestamp(rng: Rng): string {
  return new Date(EPOCH_ORIGIN_MS + rangeInt(rng, 0, 15_552_000_000)).toISOString();
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Canonical JSON: keys in sorted order, no insignificant whitespace. WokeNet signs the canonical
 * form, so the corpus must be canonical too or it would not be representative of wire bytes.
 */
function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`);
  return `{${entries.join(',')}}`;
}

const UTF8 = new TextEncoder();

function toBytes(text: string): Uint8Array {
  return UTF8.encode(text);
}

const TEXT_FRAGMENTS: readonly string[] = [
  'sovereignty is a protocol property, not a policy setting',
  'la souveraineté numérique commence par le stockage adressé par contenu',
  'децентрализация — это инженерная дисциплина, а не идеология',
  '内容寻址让每个字节在全网只存储一次',
  'コンテンツアドレッシングにより、各バイトは一度だけ保存されます',
  'الشبكة اللامركزية تحتاج إلى ضغط فعال للبيانات الوصفية',
  'la sovranità significa che nessuno può cancellare il tuo archivio',
  'chunking по содержимому выдерживает вставку и удаление байтов',
  '탈중앙화 비디오는 중복 제거에서 승부가 갈린다',
  'ओपन प्रोटोकॉल पर आधारित वीडियो नेटवर्क',
  'round-trip survivors: 🌱 🛰️ 🔗 📼 — every byte accounted for',
  'μια αποκεντρωμένη βιβλιοθήκη δεν διαγράφεται με ένα email',
];

const HANDLES: readonly string[] = [
  'ada',
  'mira',
  'kenji',
  'zoë',
  'olu',
  'sasha',
  'nadia',
  'tomas',
  'lin',
  'rafa',
  'ingrid',
  'yusuf',
];

const LANGUAGES: readonly string[] = ['en', 'fr', 'ru', 'zh-Hans', 'ja', 'ar', 'it', 'ko', 'hi'];

const TAGS: readonly string[] = [
  'wokenet',
  'middle-out',
  'content-addressing',
  'dedup',
  'sovereignty',
  'video',
  'protocol',
  'energy',
  'p2p',
];

const ENVELOPE_KINDS: readonly string[] = [
  'wokenet.post.v1',
  'wokenet.profile.v1',
  'wokenet.media.manifest.v1',
  'wokenet.reaction.v1',
  'wokenet.follow.v1',
];

const VIDEO_CODECS: readonly string[] = [
  'av01.0.08M.08',
  'av01.0.05M.08',
  'hvc1.2.4.L123.B0',
  'avc1.640028',
  'avc1.42c01e',
];

const AUDIO_CODECS: readonly string[] = ['mp4a.40.2', 'opus', 'ec-3'];

interface Rung {
  readonly bandwidth: number;
  readonly frameRate: string;
  readonly height: number;
  readonly name: string;
  readonly width: number;
}

/** Highest rung first: rendition 0 is the reference encode the lower rungs are derived from. */
const RENDITION_LADDER: readonly Rung[] = [
  { bandwidth: 8_200_000, frameRate: '29.970', height: 2160, name: '2160p', width: 3840 },
  { bandwidth: 4_500_000, frameRate: '29.970', height: 1080, name: '1080p', width: 1920 },
  { bandwidth: 2_100_000, frameRate: '29.970', height: 720, name: '720p', width: 1280 },
  { bandwidth: 880_000, frameRate: '29.970', height: 480, name: '480p', width: 854 },
  { bandwidth: 340_000, frameRate: '25.000', height: 360, name: '360p', width: 640 },
];

function sentence(rng: Rng, fragments: number): string {
  const parts: string[] = [];
  for (let i = 0; i < fragments; i += 1) {
    parts.push(pick(TEXT_FRAGMENTS, rng()));
  }
  return parts.join('. ');
}

function decimalString(value: number): string {
  return String(value);
}

function envelopeContent(rng: Rng, kind: string): JsonValue {
  switch (kind) {
    case 'wokenet.post.v1': {
      const mentions: JsonValue[] = [];
      for (let i = 0; i < rangeInt(rng, 0, 3); i += 1) {
        mentions.push(identityId(rng));
      }
      const attachments: JsonValue[] = [];
      for (let i = 0; i < rangeInt(rng, 0, 3); i += 1) {
        attachments.push({
          byteLength: rangeInt(rng, 20_000, 4_000_000),
          cid: randomCid(rng),
          mimeType: pick(['image/avif', 'image/webp', 'video/mp4', 'audio/opus'], rng()),
        });
      }
      return {
        attachments,
        body: sentence(rng, rangeInt(rng, 1, 4)),
        language: pick(LANGUAGES, rng()),
        mentions,
        replyTo: rng() % 3 === 0 ? randomCid(rng) : null,
        tags: [pick(TAGS, rng()), pick(TAGS, rng())],
      };
    }
    case 'wokenet.profile.v1':
      return {
        avatar: randomCid(rng),
        banner: randomCid(rng),
        bio: sentence(rng, 2),
        displayName: `${pick(HANDLES, rng())} ${pick(HANDLES, rng())}`,
        handle: `${pick(HANDLES, rng())}${decimalString(rangeInt(rng, 10, 9999))}`,
        pinned: randomCid(rng),
        verifiedKeys: [signingKeyId(rng), signingKeyId(rng)],
      };
    case 'wokenet.media.manifest.v1': {
      const renditions: JsonValue[] = [];
      for (let i = 0; i < rangeInt(rng, 2, 5); i += 1) {
        const rung = pick(RENDITION_LADDER, i);
        renditions.push({
          audioCodec: pick(AUDIO_CODECS, rng()),
          bandwidth: rung.bandwidth,
          height: rung.height,
          playlist: randomCid(rng),
          segmentCount: decimalString(rangeInt(rng, 120, 900)),
          videoCodec: pick(VIDEO_CODECS, rng()),
          width: rung.width,
        });
      }
      return {
        durationMs: decimalString(rangeInt(rng, 30_000, 7_200_000)),
        renditions,
        root: randomCid(rng),
        thumbnail: randomCid(rng),
        title: sentence(rng, 1),
      };
    }
    case 'wokenet.reaction.v1':
      return {
        emoji: pick(['🌱', '🔗', '📼', '🛰️', '⚡'], rng()),
        target: randomCid(rng),
      };
    default:
      return {
        target: identityId(rng),
        targetKey: signingKeyId(rng),
      };
  }
}

/**
 * Signed WokeNet protocol envelopes in canonical JSON.
 *
 * These are the Layer 2 hard case: most of every document is encoded randomness (base58 keys,
 * multibase digests, CIDs, exact-ms timestamps, decimal-string counters) that a general-purpose
 * compressor cannot model, wrapped in highly repetitive structure that it can.
 */
export function generateProtocolCorpus(count = 500): Uint8Array[] {
  const rng = createRng(CORPUS_SEEDS.protocol);
  // One network id shared by every envelope, as it would be on a real network.
  const network = `woke:net:v1:${randomPublicKey(rng)}`;
  const out: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const kind = pick(ENVELOPE_KINDS, rng());
    const document: JsonValue = {
      author: identityId(rng),
      content: envelopeContent(rng, kind),
      contentDigest: randomDigest(rng),
      createdAt: timestamp(rng),
      kind,
      network,
      prev: index === 0 ? null : randomCid(rng),
      protocol: 'wokenet',
      protocolVersion: '1.4.0',
      schemaVersion: '3',
      seq: decimalString(index + 1),
      signature: randomSignature(rng),
      signingKey: signingKeyId(rng),
    };
    out.push(toBytes(canonicalJson(document)));
  }
  return out;
}

function captionTrack(rng: Rng): JsonValue {
  return {
    byteLength: rangeInt(rng, 4_000, 90_000),
    cid: randomCid(rng),
    digest: randomDigest(rng),
    forced: false,
    label: pick(
      ['English', 'Français', 'Русский', '简体中文', '日本語', 'العربية', '한국어'],
      rng(),
    ),
    language: pick(LANGUAGES, rng()),
  };
}

function thumbnailTile(rng: Rng, index: number): JsonValue {
  return {
    cid: randomCid(rng),
    height: 180,
    offsetMs: decimalString(index * 10_000),
    width: 320,
  };
}

function manifestSegment(rng: Rng, sequence: number, bandwidth: number): JsonValue {
  const durationMs = rangeInt(rng, 3_800, 4_200);
  return {
    byteLength: Math.round((bandwidth / 8) * (durationMs / 1000)),
    cid: randomCid(rng),
    durationMs: decimalString(durationMs),
    sequence: decimalString(sequence),
  };
}

function manifestRendition(rng: Rng, rung: Rung, segmentCount: number): JsonValue {
  const segments: JsonValue[] = [];
  for (let sequence = 0; sequence < segmentCount; sequence += 1) {
    segments.push(manifestSegment(rng, sequence, rung.bandwidth));
  }
  return {
    audioCodec: pick(AUDIO_CODECS, rng()),
    bandwidth: rung.bandwidth,
    frameRate: rung.frameRate,
    height: rung.height,
    initSegment: randomCid(rng),
    name: rung.name,
    playlist: randomCid(rng),
    segments,
    videoCodec: pick(VIDEO_CODECS, rng()),
    width: rung.width,
  };
}

/**
 * HLS-shaped media manifests: the metadata a decentralized video network actually ships on every
 * playback start. Each manifest carries several renditions, each with 100+ segment entries, and
 * every segment entry contains a fresh CID — i.e. 59 characters of incompressible base32 per
 * ~4 seconds of video.
 */
export function generateMediaManifestCorpus(count = 200): Uint8Array[] {
  const rng = createRng(CORPUS_SEEDS.mediaManifest);
  const network = `woke:net:v1:${randomPublicKey(rng)}`;
  const out: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const segmentCount = rangeInt(rng, 100, 113);
    const rungCount = rangeInt(rng, 2, 4);
    const renditions: JsonValue[] = [];
    for (let rung = 0; rung < rungCount; rung += 1) {
      renditions.push(manifestRendition(rng, pick(RENDITION_LADDER, rung + 1), segmentCount));
    }
    const captions: JsonValue[] = [];
    for (let i = 0; i < rangeInt(rng, 1, 4); i += 1) {
      captions.push(captionTrack(rng));
    }
    const thumbnails: JsonValue[] = [];
    for (let i = 0; i < rangeInt(rng, 6, 13); i += 1) {
      thumbnails.push(thumbnailTile(rng, i));
    }
    const manifest: JsonValue = {
      captions,
      createdAt: timestamp(rng),
      durationMs: decimalString(segmentCount * 4000),
      id: randomCid(rng),
      manifestVersion: '2',
      network,
      protocol: 'wokenet.media',
      protocolVersion: '1.2.0',
      publisher: identityId(rng),
      renditions,
      signature: randomSignature(rng),
      signingKey: signingKeyId(rng),
      thumbnails,
      title: sentence(rng, 1),
    };
    out.push(toBytes(canonicalJson(manifest)));
  }
  return out;
}

export interface VideoSegmentCorpusOptions {
  /** Nominal segment size of the reference rendition, in bytes. */
  readonly segmentBytes?: number;
  /** Segments per rendition. */
  readonly segmentCount?: number;
  /** How many ladder rungs to synthesize (capped at the ladder length). */
  readonly renditionCount?: number;
  /** Every Nth segment is byte-identical across all renditions. */
  readonly sharedSegmentStride?: number;
  /** Length of the intro prepended by the re-uploader. */
  readonly introBytes?: number;
  readonly seed?: number;
}

export interface VideoSegmentCorpus {
  /** `renditions[rung][index]` — one blob per encoded segment. */
  readonly renditions: Uint8Array[][];
  /** The same video re-uploaded with a short intro prepended, re-cut at the same granularity. */
  readonly reuploadWithIntro: Uint8Array[];
}

/** Relative segment size per ladder rung, index 0 being the reference encode. */
const RUNG_SIZE_FACTORS: readonly number[] = [1, 0.55, 0.3, 0.18, 0.1];

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function splitFixed(bytes: Uint8Array, partLength: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += partLength) {
    parts.push(bytes.subarray(offset, Math.min(offset + partLength, bytes.length)));
  }
  return parts;
}

/**
 * The decentralized-video case, synthesized honestly.
 *
 * The segment payloads are pseudo-random bytes. They stand in for real encoded video, and because
 * they are near-maximum entropy they are the HARD case: no entropy coder can shrink them, so any
 * saving measured on this corpus comes from deduplication alone and not from accidentally
 * compressible synthetic structure. Two real-world reuse patterns are modelled:
 *
 *  (a) Segments shared byte-for-byte across renditions. In practice these are the pre-rendered
 *      intro/outro/sponsor stingers muxed identically into every rung of the ladder, plus plain
 *      mirrors of an existing rung. They are the case fixed-size blocking already handles.
 *  (b) A re-upload of the same video with a short intro prepended, then re-cut at the same
 *      granularity. Every downstream byte is now shifted by a non-multiple of the block size,
 *      which is exactly where fixed-size blocking finds nothing and content-defined chunking
 *      re-synchronizes after one boundary.
 */
export function generateVideoSegmentCorpus(
  options?: VideoSegmentCorpusOptions,
): VideoSegmentCorpus {
  const segmentBytes = options?.segmentBytes ?? 12_288;
  const segmentCount = options?.segmentCount ?? 48;
  const renditionCount = Math.min(options?.renditionCount ?? 4, RENDITION_LADDER.length);
  const sharedSegmentStride = options?.sharedSegmentStride ?? 4;
  const introBytes = options?.introBytes ?? 5_003;
  const rng = createRng(options?.seed ?? CORPUS_SEEDS.videoSegments);

  const reference: Uint8Array[] = [];
  for (let index = 0; index < segmentCount; index += 1) {
    reference.push(randomBytes(rng, segmentBytes));
  }

  const renditions: Uint8Array[][] = [reference];
  for (let rung = 1; rung < renditionCount; rung += 1) {
    const factor = RUNG_SIZE_FACTORS[rung] ?? 0.1;
    const rungSegments: Uint8Array[] = [];
    for (let index = 0; index < segmentCount; index += 1) {
      const shared = reference[index];
      if (index % sharedSegmentStride === 0 && shared !== undefined) {
        rungSegments.push(shared);
      } else {
        rungSegments.push(randomBytes(rng, Math.round(segmentBytes * factor)));
      }
    }
    renditions.push(rungSegments);
  }

  const intro = randomBytes(rng, introBytes);
  const reuploadWithIntro = splitFixed(concatBytes([intro, ...reference]), segmentBytes);

  return { renditions, reuploadWithIntro };
}
