/**
 * Recognizers for the text-encoded-randomness forms that dominate WokeNet
 * protocol envelopes, media manifests and playlists.
 *
 * A base58 public key, a multibase digest or a CIDv1 string is 32 bytes of
 * high-entropy material stretched over 44-59 characters of a restricted
 * alphabet. General-purpose compressors cannot recover that: the text looks
 * incompressible because the *encoding* is what wasted the space, not the
 * content. Parsing inward to raw bytes and entropy-coding outward from there
 * wins by construction.
 *
 * Every form here is a triple: a total detector (never throws, never guesses), a
 * parse to raw bytes, and a formatter back to text. Detection is canonical —
 * `format(parse(text)) === text` is verified inside the detector — so a token
 * can only be produced for input the formatter provably reproduces exactly.
 */

import bs58 from 'bs58';
import { Buffer } from 'node:buffer';
import { ByteCodecError, type ByteReader, type ByteWriter } from './varint.js';

/* -------------------------------------------------------------------------- */
/* Tag bytes                                                                  */
/* -------------------------------------------------------------------------- */

export const TAG_NULL = 0x00;
export const TAG_FALSE = 0x01;
export const TAG_TRUE = 0x02;
export const TAG_UINT = 0x03;
export const TAG_NEGINT = 0x04;
export const TAG_NUMBER_TEXT = 0x05;
export const TAG_STRING_REF = 0x06;
export const TAG_INT_TEXT = 0x07;
export const TAG_TIMESTAMP_MS = 0x08;
export const TAG_BASE58_32 = 0x09;
export const TAG_MULTIBASE64URL_32 = 0x0a;
export const TAG_CID_RAW_SHA256 = 0x0b;
export const TAG_COMPOSITE_ID = 0x0c;
export const TAG_ARRAY = 0x0d;
export const TAG_OBJECT = 0x0e;

/** Every recognized fixed-width form carries exactly one 32-byte payload. */
export const RAW_32 = 32;

/* -------------------------------------------------------------------------- */
/* Token model                                                                */
/* -------------------------------------------------------------------------- */

/** Tail segment of a composite identifier: always a 32-byte form. */
export type CompositeTailSegment =
  | { readonly tag: typeof TAG_BASE58_32; readonly bytes: Uint8Array }
  | { readonly tag: typeof TAG_MULTIBASE64URL_32; readonly bytes: Uint8Array };

/** Tokens that stand for a JSON string (a value, or an object key). */
export type StringToken =
  | { readonly tag: typeof TAG_STRING_REF; readonly index: number }
  | { readonly tag: typeof TAG_INT_TEXT; readonly value: number }
  | { readonly tag: typeof TAG_TIMESTAMP_MS; readonly epochMillis: number }
  | { readonly tag: typeof TAG_BASE58_32; readonly bytes: Uint8Array }
  | { readonly tag: typeof TAG_MULTIBASE64URL_32; readonly bytes: Uint8Array }
  | { readonly tag: typeof TAG_CID_RAW_SHA256; readonly digest: Uint8Array }
  | {
      readonly tag: typeof TAG_COMPOSITE_ID;
      readonly prefixRef: number;
      readonly tail: readonly CompositeTailSegment[];
    };

/** The complete middle representation: one token per JSON node. */
export type Token =
  | StringToken
  | { readonly tag: typeof TAG_NULL }
  | { readonly tag: typeof TAG_FALSE }
  | { readonly tag: typeof TAG_TRUE }
  | { readonly tag: typeof TAG_UINT; readonly value: number }
  | { readonly tag: typeof TAG_NEGINT; readonly magnitude: number }
  | { readonly tag: typeof TAG_NUMBER_TEXT; readonly text: string }
  | { readonly tag: typeof TAG_ARRAY; readonly length: number }
  | { readonly tag: typeof TAG_OBJECT; readonly size: number };

/* -------------------------------------------------------------------------- */
/* base32, lowercase RFC 4648, unpadded                                       */
/* -------------------------------------------------------------------------- */

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = accumulator * 256 + byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET.charAt(Math.floor(accumulator / 2 ** bits) % 32);
      accumulator %= 2 ** bits;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET.charAt((accumulator * 2 ** (5 - bits)) % 32);
  }
  return out;
}

/**
 * Decodes lowercase base32. Returns `null` for any character outside the
 * alphabet. Trailing bits that do not complete a byte are dropped; callers
 * detect that non-canonical case by re-encoding and comparing.
 */
export function base32Decode(text: string): Uint8Array | null {
  const bytes = new Uint8Array(Math.floor((text.length * 5) / 8));
  let accumulator = 0;
  let bits = 0;
  let written = 0;
  for (const character of text) {
    const digit = BASE32_ALPHABET.indexOf(character);
    if (digit < 0) {
      return null;
    }
    accumulator = accumulator * 32 + digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[written] = Math.floor(accumulator / 2 ** bits) % 256;
      written += 1;
      accumulator %= 2 ** bits;
    }
  }
  return written === bytes.length ? bytes : null;
}

/* -------------------------------------------------------------------------- */
/* base58 32-byte public keys                                                 */
/* -------------------------------------------------------------------------- */

/** 32 zero bytes encode to 32 chars; 32 x 0xff encodes to 44. */
const BASE58_KEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Parses a canonical base58 32-byte key, or returns `null`. */
export function parseBase58Key32(text: string): Uint8Array | null {
  if (!BASE58_KEY_PATTERN.test(text)) {
    return null;
  }
  const decoded = bs58.decodeUnsafe(text);
  if (decoded === undefined || decoded.length !== RAW_32) {
    return null;
  }
  return formatBase58Key32(decoded) === text ? decoded : null;
}

export function formatBase58Key32(bytes: Uint8Array): string {
  return bs58.encode(bytes);
}

export function isBase58Key32(text: string): boolean {
  return parseBase58Key32(text) !== null;
}

/* -------------------------------------------------------------------------- */
/* multibase base64url 32-byte digests ('u' + 43 chars)                       */
/* -------------------------------------------------------------------------- */

const MULTIBASE64URL_PATTERN = /^u[A-Za-z0-9_-]{43}$/;

/** Parses a canonical multibase base64url 32-byte digest, or returns `null`. */
export function parseMultibaseDigest32(text: string): Uint8Array | null {
  if (!MULTIBASE64URL_PATTERN.test(text)) {
    return null;
  }
  const decoded = new Uint8Array(Buffer.from(text.slice(1), 'base64url'));
  if (decoded.length !== RAW_32) {
    return null;
  }
  return formatMultibaseDigest32(decoded) === text ? decoded : null;
}

export function formatMultibaseDigest32(bytes: Uint8Array): string {
  return `u${Buffer.from(bytes).toString('base64url')}`;
}

export function isMultibaseDigest32(text: string): boolean {
  return parseMultibaseDigest32(text) !== null;
}

/* -------------------------------------------------------------------------- */
/* CIDv1 raw / sha2-256                                                       */
/* -------------------------------------------------------------------------- */

const CID_V1_RAW_SHA256_PATTERN = /^bafkrei[a-z2-7]{52}$/;

/** cidv1 (0x01), raw codec (0x55), sha2-256 (0x12), 32-byte length (0x20). */
const CID_V1_RAW_SHA256_PREFIX = Uint8Array.of(0x01, 0x55, 0x12, 0x20);

/** Parses the 32 digest bytes out of a canonical `bafkrei…` CID, or returns `null`. */
export function parseCidV1RawSha256(text: string): Uint8Array | null {
  if (!CID_V1_RAW_SHA256_PATTERN.test(text)) {
    return null;
  }
  // Strip the multibase prefix 'b' (base32 lower) before decoding the body.
  const framed = base32Decode(text.slice(1));
  if (framed === null || framed.length !== CID_V1_RAW_SHA256_PREFIX.length + RAW_32) {
    return null;
  }
  for (let index = 0; index < CID_V1_RAW_SHA256_PREFIX.length; index += 1) {
    if (framed[index] !== CID_V1_RAW_SHA256_PREFIX[index]) {
      return null;
    }
  }
  const digest = framed.subarray(CID_V1_RAW_SHA256_PREFIX.length);
  return formatCidV1RawSha256(digest) === text ? digest : null;
}

export function formatCidV1RawSha256(digest: Uint8Array): string {
  const framed = new Uint8Array(CID_V1_RAW_SHA256_PREFIX.length + digest.length);
  framed.set(CID_V1_RAW_SHA256_PREFIX, 0);
  framed.set(digest, CID_V1_RAW_SHA256_PREFIX.length);
  return `b${base32Encode(framed)}`;
}

export function isCidV1RawSha256(text: string): boolean {
  return parseCidV1RawSha256(text) !== null;
}

/* -------------------------------------------------------------------------- */
/* Exact-millisecond UTC ISO timestamps                                       */
/* -------------------------------------------------------------------------- */

const ISO_MILLIS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Parses an exact-millisecond UTC ISO timestamp to epoch millis, or `null`. */
export function parseExactMillisTimestamp(text: string): number | null {
  if (!ISO_MILLIS_PATTERN.test(text)) {
    return null;
  }
  const epochMillis = Date.parse(text);
  // Pre-1970 instants would need a signed varint; they are simply not recognized.
  if (!Number.isSafeInteger(epochMillis) || epochMillis < 0) {
    return null;
  }
  return formatExactMillisTimestamp(epochMillis) === text ? epochMillis : null;
}

export function formatExactMillisTimestamp(epochMillis: number): string {
  return new Date(epochMillis).toISOString();
}

export function isExactMillisTimestamp(text: string): boolean {
  return parseExactMillisTimestamp(text) !== null;
}

/* -------------------------------------------------------------------------- */
/* Decimal integer strings                                                    */
/* -------------------------------------------------------------------------- */

const DECIMAL_INTEGER_PATTERN = /^(?:0|[1-9]\d{0,15})$/;

/**
 * Parses a decimal integer string. The pattern admits 16 digits, which reaches
 * past `Number.MAX_SAFE_INTEGER`, so the value is additionally checked for
 * exactness both ways.
 */
export function parseDecimalIntegerText(text: string): number | null {
  if (!DECIMAL_INTEGER_PATTERN.test(text)) {
    return null;
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    return null;
  }
  return formatDecimalIntegerText(value) === text ? value : null;
}

export function formatDecimalIntegerText(value: number): string {
  return String(value);
}

export function isDecimalIntegerText(text: string): boolean {
  return parseDecimalIntegerText(text) !== null;
}

/* -------------------------------------------------------------------------- */
/* Composite WokeNet identifiers                                              */
/* -------------------------------------------------------------------------- */

export interface CompositeIdAnalysis {
  /** Colon-joined leading segments, stored verbatim in the string dictionary. */
  readonly prefix: string;
  /** One or more trailing 32-byte segments, stored as raw bytes. */
  readonly tail: readonly CompositeTailSegment[];
}

/**
 * Splits an identifier such as
 * `wokenet:mainnet:media:<base58key>:<u-digest>` into a textual prefix plus its
 * recognized trailing segments.
 *
 * Reversibility is structural: `text.split(':')` and `join(':')` are exact
 * inverses, the prefix is stored verbatim, and each tail segment is only
 * accepted by a canonical detector. At least one leading segment is required so
 * the rebuild is always `prefix + ':' + tail.join(':')` — which means a corpus
 * of thousands of identifiers sharing a network prefix collapses that prefix to
 * a single dictionary entry.
 */
export function analyzeCompositeId(text: string): CompositeIdAnalysis | null {
  if (!text.includes(':')) {
    return null;
  }
  const segments = text.split(':');
  const tail: CompositeTailSegment[] = [];
  let boundary = segments.length;
  while (boundary > 1) {
    const segment = segments[boundary - 1];
    if (segment === undefined) {
      break;
    }
    const key = parseBase58Key32(segment);
    if (key !== null) {
      tail.unshift({ tag: TAG_BASE58_32, bytes: key });
      boundary -= 1;
      continue;
    }
    const digest = parseMultibaseDigest32(segment);
    if (digest !== null) {
      tail.unshift({ tag: TAG_MULTIBASE64URL_32, bytes: digest });
      boundary -= 1;
      continue;
    }
    break;
  }
  if (tail.length === 0) {
    return null;
  }
  return { prefix: segments.slice(0, boundary).join(':'), tail };
}

export function formatCompositeId(prefix: string, tail: readonly CompositeTailSegment[]): string {
  let out = prefix;
  for (const segment of tail) {
    out += ':';
    out +=
      segment.tag === TAG_BASE58_32
        ? formatBase58Key32(segment.bytes)
        : formatMultibaseDigest32(segment.bytes);
  }
  return out;
}

export function isCompositeId(text: string): boolean {
  return analyzeCompositeId(text) !== null;
}

/* -------------------------------------------------------------------------- */
/* String -> token -> string                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Parses a JSON string inward to the smallest typed token that provably
 * reproduces it. Returns `null` when no form matches, leaving the caller to
 * intern the string in the dictionary.
 *
 * `internPrefix` is called only for composite identifiers, to place their
 * textual prefix in the shared dictionary.
 */
export function recognizeString(
  text: string,
  internPrefix: (prefix: string) => number,
): StringToken | null {
  const key = parseBase58Key32(text);
  if (key !== null) {
    return { tag: TAG_BASE58_32, bytes: key };
  }
  const digest = parseMultibaseDigest32(text);
  if (digest !== null) {
    return { tag: TAG_MULTIBASE64URL_32, bytes: digest };
  }
  const cid = parseCidV1RawSha256(text);
  if (cid !== null) {
    return { tag: TAG_CID_RAW_SHA256, digest: cid };
  }
  const epochMillis = parseExactMillisTimestamp(text);
  if (epochMillis !== null) {
    return { tag: TAG_TIMESTAMP_MS, epochMillis };
  }
  const integer = parseDecimalIntegerText(text);
  if (integer !== null) {
    return { tag: TAG_INT_TEXT, value: integer };
  }
  const composite = analyzeCompositeId(text);
  if (composite !== null) {
    return {
      tag: TAG_COMPOSITE_ID,
      prefixRef: internPrefix(composite.prefix),
      tail: composite.tail,
    };
  }
  return null;
}

/** Writes a string token, tag byte first. */
export function writeStringToken(writer: ByteWriter, token: StringToken): void {
  writer.pushByte(token.tag);
  switch (token.tag) {
    case TAG_STRING_REF:
      writer.pushVarint(token.index);
      return;
    case TAG_INT_TEXT:
      writer.pushVarint(token.value);
      return;
    case TAG_TIMESTAMP_MS:
      writer.pushVarint(token.epochMillis);
      return;
    case TAG_BASE58_32:
    case TAG_MULTIBASE64URL_32:
      writer.pushBytes(token.bytes);
      return;
    case TAG_CID_RAW_SHA256:
      writer.pushBytes(token.digest);
      return;
    case TAG_COMPOSITE_ID:
      writer.pushVarint(token.prefixRef);
      writer.pushVarint(token.tail.length);
      for (const segment of token.tail) {
        writer.pushByte(segment.tag);
        writer.pushBytes(segment.bytes);
      }
      return;
  }
}

/**
 * Reads the payload of a string token whose `tag` byte the caller already
 * consumed. Returns `null` — consuming nothing — when `tag` is not a string tag,
 * so a value reader can fall through to the structural tags.
 */
export function readStringToken(tag: number, reader: ByteReader): StringToken | null {
  switch (tag) {
    case TAG_STRING_REF:
      return { tag: TAG_STRING_REF, index: reader.readVarint() };
    case TAG_INT_TEXT:
      return { tag: TAG_INT_TEXT, value: reader.readVarint() };
    case TAG_TIMESTAMP_MS:
      return { tag: TAG_TIMESTAMP_MS, epochMillis: reader.readVarint() };
    case TAG_BASE58_32:
      return { tag: TAG_BASE58_32, bytes: reader.readBytes(RAW_32) };
    case TAG_MULTIBASE64URL_32:
      return { tag: TAG_MULTIBASE64URL_32, bytes: reader.readBytes(RAW_32) };
    case TAG_CID_RAW_SHA256:
      return { tag: TAG_CID_RAW_SHA256, digest: reader.readBytes(RAW_32) };
    case TAG_COMPOSITE_ID: {
      const prefixRef = reader.readVarint();
      const count = reader.readVarint();
      const tail: CompositeTailSegment[] = [];
      for (let index = 0; index < count; index += 1) {
        const segmentTag = reader.readByte();
        if (segmentTag === TAG_BASE58_32 || segmentTag === TAG_MULTIBASE64URL_32) {
          tail.push({ tag: segmentTag, bytes: reader.readBytes(RAW_32) });
        } else {
          throw new ByteCodecError(`invalid composite id segment tag 0x${hex(segmentTag)}`);
        }
      }
      return { tag: TAG_COMPOSITE_ID, prefixRef, tail };
    }
    default:
      return null;
  }
}

/** Renders a string token back to its exact original text. */
export function renderStringToken(token: StringToken, dictionary: readonly string[]): string {
  switch (token.tag) {
    case TAG_STRING_REF:
      return lookupDictionary(dictionary, token.index);
    case TAG_INT_TEXT:
      return formatDecimalIntegerText(token.value);
    case TAG_TIMESTAMP_MS:
      return formatExactMillisTimestamp(token.epochMillis);
    case TAG_BASE58_32:
      return formatBase58Key32(token.bytes);
    case TAG_MULTIBASE64URL_32:
      return formatMultibaseDigest32(token.bytes);
    case TAG_CID_RAW_SHA256:
      return formatCidV1RawSha256(token.digest);
    case TAG_COMPOSITE_ID:
      return formatCompositeId(lookupDictionary(dictionary, token.prefixRef), token.tail);
  }
}

function lookupDictionary(dictionary: readonly string[], index: number): string {
  const entry = dictionary[index];
  if (entry === undefined) {
    throw new ByteCodecError(
      `dictionary reference ${index} out of range (${dictionary.length} entries)`,
    );
  }
  return entry;
}

function hex(byte: number): string {
  return byte.toString(16).padStart(2, '0');
}
