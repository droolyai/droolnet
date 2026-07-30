/**
 * Adversarial regression suite: written to break the codec, kept to stop it breaking again.
 *
 * The standard here is one sentence: for every input in this file,
 * `decodeMiddleOut(encodeMiddleOut(input))` must be byte-identical to `input`, and
 * `encodeMiddleOut` must never throw. Layer 1 gets the same treatment: every chunking of
 * every input must be gapless, overlap-free, non-empty, within `maxSize`, and reassemble
 * byte-exactly.
 *
 * Two of the assertions below are the ones that actually have teeth, and they are worth
 * naming because they are not obvious:
 *
 * 1. **Near-miss forms must still take the *transcoded* path.** Losslessness alone is a weak
 *    test: a codec that answered every input with passthrough would pass it. Every string
 *    case in `near-miss recognizer forms` is embedded in a document built by `JSON.stringify`,
 *    so the document is canonical by construction and the only reason left to fall back is a
 *    recognizer that mis-parses a non-canonical string into a token that renders differently.
 *    Asserting `Transcoded` therefore catches a broken recognizer that the self-verify step
 *    would otherwise hide behind a silent, correct, useless fallback.
 * 2. **Every failure `decodeMiddleOut` can produce must be a `MiddleOutFormatError`.** The
 *    corruption cases feed it thousands of mutated containers and assert that nothing else
 *    escapes — no `TypeError` from a bad index, no raw `RangeError` from an allocation the
 *    header asked for.
 */

import { createHash } from 'node:crypto';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import {
  chunkBytes,
  DEFAULT_CHUNKING_OPTIONS,
  resolveChunkingOptions,
  type Chunk,
  type ChunkingOptions,
} from '../src/chunking.js';
import {
  base32Encode,
  formatCidV1RawSha256,
  formatMultibaseDigest32,
  isBase58Key32,
  isCidV1RawSha256,
  isDecimalIntegerText,
  isExactMillisTimestamp,
  isMultibaseDigest32,
} from '../src/recognizers.js';
import {
  decodeMiddleOut,
  encodeMiddleOut,
  MiddleOutFormatError,
  MiddleOutMode,
  readMiddleOutMode,
} from '../src/transcode.js';

const encoder = new TextEncoder();

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

/** Hex, truncated, with the true length always stated — failure output must be actionable. */
function hex(bytes: Uint8Array, limit = 64): string {
  const head = Array.from(bytes.subarray(0, limit), (byte) => byte.toString(16).padStart(2, '0'));
  const ellipsis = bytes.length > limit ? ' …' : '';
  return `[${String(bytes.length)} B] ${head.join(' ')}${ellipsis}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * The single assertion this file is built around: encode must not throw, the result must be a
 * container, and decoding it must give back the exact input bytes. Returns the mode so callers
 * can additionally assert *which* path was taken.
 */
function roundTripMode(label: string, input: Uint8Array): MiddleOutMode {
  let container: Uint8Array;
  try {
    container = encodeMiddleOut(input);
  } catch (error) {
    throw new Error(`${label}: encodeMiddleOut threw ${describeError(error)}\n  in  ${hex(input)}`);
  }
  const mode = readMiddleOutMode(container);
  if (mode === null) {
    throw new Error(`${label}: encodeMiddleOut produced a non-container\n  out ${hex(container)}`);
  }
  let decoded: Uint8Array;
  try {
    decoded = decodeMiddleOut(container);
  } catch (error) {
    throw new Error(
      `${label}: decodeMiddleOut threw ${describeError(error)}` +
        `\n  in  ${hex(input)}\n  cnt ${hex(container)}`,
    );
  }
  if (!bytesEqual(decoded, input)) {
    throw new Error(
      `${label}: LOSSY round trip (mode ${String(mode)})` +
        `\n  in  ${hex(input, 128)}\n  out ${hex(decoded, 128)}\n  cnt ${hex(container, 128)}`,
    );
  }
  return mode;
}

/** splitmix32. Fixed seeds only: a fuzz failure nobody can re-run is not a finding. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e37_79b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0_aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a_2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
}

function digest32(label: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(label).digest());
}

const base58Key = (label: string): string => bs58.encode(digest32(label));
const digestText = (label: string): string => formatMultibaseDigest32(digest32(label));
const cidText = (label: string): string => formatCidV1RawSha256(digest32(label));
/** A literal epoch offset, never a clock read: the corpus must not drift between runs. */
const isoAt = (epochMillis: number): string => new Date(epochMillis).toISOString();

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE32_LOWER_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * Replaces the final character with one carrying non-zero bits in the padding region.
 *
 * A 32-byte payload is 256 bits, and both encodings overshoot it — 43 base64url characters
 * carry 258 bits, 58 base32 characters carry 290 — so the trailing bits of the last character
 * are structurally zero in a canonical string. Setting them is the exact non-canonical form a
 * length check alone cannot catch, and only the `format(parse(x)) === x` comparison rejects.
 */
function dirtyPaddingBits(text: string, alphabet: string): string {
  const last = text.charAt(text.length - 1);
  const value = alphabet.indexOf(last);
  const dirtied = alphabet.charAt((value | 0b11) % alphabet.length);
  return `${text.slice(0, -1)}${dirtied}`;
}

/** A `bafkrei…`-shaped CID whose multihash length byte is 0x21 instead of 0x20. */
function cidWithBadMultihashPrefix(label: string): string {
  const framed = new Uint8Array(4 + 32);
  framed.set(Uint8Array.of(0x01, 0x55, 0x12, 0x21), 0);
  framed.set(digest32(label), 4);
  return `b${base32Encode(framed)}`;
}

/** A `bafkrei…`-shaped CID whose codec byte is dag-pb (0x70) instead of raw (0x55). */
function cidWithForeignCodec(label: string): string {
  const framed = new Uint8Array(4 + 32);
  framed.set(Uint8Array.of(0x01, 0x70, 0x12, 0x20), 0);
  framed.set(digest32(label), 4);
  return `b${base32Encode(framed)}`;
}

function brotliMax(input: Uint8Array): Uint8Array {
  return new Uint8Array(
    brotliCompressSync(input, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: input.length,
      },
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* 1. Near-miss recognizer forms                                              */
/* -------------------------------------------------------------------------- */

/**
 * Strings that look like a recognized form but are not canonical instances of it.
 *
 * `canonical` records whether the detectors are expected to claim the string at all, so the
 * detector predicates get asserted directly rather than only through the codec.
 */
interface StringCase {
  readonly name: string;
  readonly text: string;
  readonly canonical: 'base58' | 'digest' | 'cid' | 'timestamp' | 'integer' | 'none';
  /**
   * Set on the cases holding an unpaired surrogate.
   *
   * These are the one family of legal JSON strings the transcoded path cannot carry: the string
   * dictionary is UTF-8 and UTF-8 has no representation for an unpaired surrogate, so a document
   * containing one loses the transcode and stores verbatim instead. `JSON.parse('"\\ud800"')`
   * produces such a string, so this is reachable from the wire, and the assertion below pins the
   * behaviour to "falls back losslessly" rather than leaving it undefined.
   */
  readonly utf8Carriable?: false;
}

const VALID_KEY = base58Key('adversarial/key');
const VALID_DIGEST = digestText('adversarial/digest');
const VALID_CID = cidText('adversarial/cid');

const STRING_CASES: readonly StringCase[] = [
  /* base58 32-byte keys ---------------------------------------------------- */
  { name: 'base58: canonical 44-char key', text: VALID_KEY, canonical: 'base58' },
  { name: 'base58: all-zero key (32 ones)', text: '1'.repeat(32), canonical: 'base58' },
  { name: 'base58: 33 ones decodes to 33 bytes', text: '1'.repeat(33), canonical: 'none' },
  { name: 'base58: 31 chars is too short', text: '1'.repeat(31), canonical: 'none' },
  { name: 'base58: 45 chars is too long', text: `${VALID_KEY}1`, canonical: 'none' },
  // 58**43 < 2**256, so 43 z characters really are a canonical 32-byte value.
  { name: 'base58: 43 z chars is a valid key', text: 'z'.repeat(43), canonical: 'base58' },
  { name: 'base58: 44 z chars overflows 32 bytes', text: 'z'.repeat(44), canonical: 'none' },
  {
    name: 'base58: contains the excluded digit 0',
    text: `0${VALID_KEY.slice(1)}`,
    canonical: 'none',
  },
  {
    name: 'base58: contains the excluded letter O',
    text: `O${VALID_KEY.slice(1)}`,
    canonical: 'none',
  },
  {
    name: 'base58: contains the excluded letter I',
    text: `I${VALID_KEY.slice(1)}`,
    canonical: 'none',
  },
  {
    name: 'base58: contains the excluded letter l',
    text: `l${VALID_KEY.slice(1)}`,
    canonical: 'none',
  },
  { name: 'base58: contains a plus sign', text: `+${VALID_KEY.slice(1)}`, canonical: 'none' },
  { name: 'base58: uppercased whole key', text: VALID_KEY.toUpperCase(), canonical: 'none' },
  { name: 'base58: lowercased whole key', text: VALID_KEY.toLowerCase(), canonical: 'none' },
  { name: 'base58: leading zero-padded key', text: `1${VALID_KEY}`, canonical: 'none' },

  /* multibase base64url digests -------------------------------------------- */
  { name: 'digest: canonical u + 43', text: VALID_DIGEST, canonical: 'digest' },
  {
    name: 'digest: non-zero padding bits in the last char',
    text: dirtyPaddingBits(VALID_DIGEST, BASE64URL_ALPHABET),
    canonical: 'none',
  },
  { name: 'digest: 42 payload chars', text: VALID_DIGEST.slice(0, -1), canonical: 'none' },
  { name: 'digest: 44 payload chars', text: `${VALID_DIGEST}A`, canonical: 'none' },
  {
    name: 'digest: wrong multibase prefix m',
    text: `m${VALID_DIGEST.slice(1)}`,
    canonical: 'none',
  },
  { name: 'digest: no multibase prefix', text: VALID_DIGEST.slice(1), canonical: 'none' },
  {
    name: 'digest: standard base64 + and / chars',
    text: `u${VALID_DIGEST.slice(1, -2)}+/`,
    canonical: 'none',
  },
  {
    name: 'digest: padded with =',
    text: `u${VALID_DIGEST.slice(1, -1)}=`,
    canonical: 'none',
  },

  /* CIDv1 raw sha2-256 ----------------------------------------------------- */
  { name: 'cid: canonical bafkrei… (59 chars)', text: VALID_CID, canonical: 'cid' },
  {
    name: 'cid: non-zero padding bits in the last char',
    text: dirtyPaddingBits(VALID_CID, BASE32_LOWER_ALPHABET),
    canonical: 'none',
  },
  {
    name: 'cid: bafkrei… with multihash length 0x21',
    text: cidWithBadMultihashPrefix('adversarial/badlen'),
    canonical: 'none',
  },
  {
    name: 'cid: dag-pb codec instead of raw',
    text: cidWithForeignCodec('adversarial/dagpb'),
    canonical: 'none',
  },
  { name: 'cid: 58 chars', text: VALID_CID.slice(0, -1), canonical: 'none' },
  { name: 'cid: 60 chars', text: `${VALID_CID}a`, canonical: 'none' },
  { name: 'cid: uppercased', text: VALID_CID.toUpperCase(), canonical: 'none' },
  {
    name: 'cid: base32 digit outside [a-z2-7]',
    text: `${VALID_CID.slice(0, -1)}1`,
    canonical: 'none',
  },
  {
    name: 'cid: bafybei prefix (dag-pb text form)',
    text: `bafybei${VALID_CID.slice(7)}`,
    canonical: 'none',
  },

  /* exact-millisecond timestamps ------------------------------------------- */
  { name: 'timestamp: unix epoch', text: '1970-01-01T00:00:00.000Z', canonical: 'timestamp' },
  {
    name: 'timestamp: canonical mid-range',
    text: isoAt(1_767_225_600_123),
    canonical: 'timestamp',
  },
  { name: 'timestamp: max 4-digit year', text: '9999-12-31T23:59:59.999Z', canonical: 'timestamp' },
  {
    name: 'timestamp: 2026-02-30 rolls over to 03-02',
    text: '2026-02-30T00:00:00.000Z',
    canonical: 'none',
  },
  { name: 'timestamp: month 13', text: '2026-13-01T00:00:00.000Z', canonical: 'none' },
  { name: 'timestamp: day 32', text: '2026-01-32T00:00:00.000Z', canonical: 'none' },
  { name: 'timestamp: day 00', text: '2026-01-00T00:00:00.000Z', canonical: 'none' },
  { name: 'timestamp: month 00', text: '2026-00-01T00:00:00.000Z', canonical: 'none' },
  { name: 'timestamp: hour 24 rolls the day', text: '2026-01-01T24:00:00.000Z', canonical: 'none' },
  { name: 'timestamp: hour 25', text: '2026-01-01T25:00:00.000Z', canonical: 'none' },
  { name: 'timestamp: second 60', text: '2026-01-01T00:00:60.000Z', canonical: 'none' },
  { name: 'timestamp: minute 60', text: '2026-01-01T00:60:00.000Z', canonical: 'none' },
  { name: 'timestamp: pre-1970', text: '1969-12-31T23:59:59.999Z', canonical: 'none' },
  { name: 'timestamp: year 0000', text: '0000-01-01T00:00:00.000Z', canonical: 'none' },
  { name: 'timestamp: expanded year form', text: '+002026-01-01T00:00:00.000Z', canonical: 'none' },
  {
    name: 'timestamp: four fractional digits',
    text: '2026-01-01T00:00:00.0000Z',
    canonical: 'none',
  },
  { name: 'timestamp: no fractional part', text: '2026-01-01T00:00:00Z', canonical: 'none' },
  { name: 'timestamp: lowercase t and z', text: '2026-01-01t00:00:00.000z', canonical: 'none' },
  { name: 'timestamp: +00:00 offset', text: '2026-01-01T00:00:00.000+00:00', canonical: 'none' },
  { name: 'timestamp: no zone', text: '2026-01-01T00:00:00.000', canonical: 'none' },
  { name: 'timestamp: trailing space', text: '2026-01-01T00:00:00.000Z ', canonical: 'none' },

  /* decimal integer strings ------------------------------------------------ */
  { name: 'integer: zero', text: '0', canonical: 'integer' },
  { name: 'integer: MAX_SAFE_INTEGER', text: '9007199254740991', canonical: 'integer' },
  { name: 'integer: 16 digits in range', text: '1234567890123456', canonical: 'integer' },
  { name: 'integer: MAX_SAFE_INTEGER + 1', text: '9007199254740992', canonical: 'none' },
  {
    name: 'integer: MAX_SAFE_INTEGER + 2 rounds down',
    text: '9007199254740993',
    canonical: 'none',
  },
  { name: 'integer: 17 digits', text: '10000000000000000', canonical: 'none' },
  { name: 'integer: leading zero', text: '01', canonical: 'none' },
  { name: 'integer: all zeros', text: '00', canonical: 'none' },
  { name: 'integer: leading zeros then digits', text: '007', canonical: 'none' },
  { name: 'integer: negative', text: '-1', canonical: 'none' },
  { name: 'integer: negative zero', text: '-0', canonical: 'none' },
  { name: 'integer: explicit plus', text: '+1', canonical: 'none' },
  { name: 'integer: exponent form', text: '1e3', canonical: 'none' },
  { name: 'integer: decimal point', text: '1.0', canonical: 'none' },
  { name: 'integer: leading space', text: ' 1', canonical: 'none' },
  { name: 'integer: trailing newline', text: '1\n', canonical: 'none' },
  { name: 'integer: fullwidth digit', text: '１', canonical: 'none' },
  { name: 'integer: arabic-indic digit', text: '١', canonical: 'none' },

  /* composite identifiers -------------------------------------------------- */
  {
    name: 'composite: prefix + key + digest',
    text: `wokenet:mainnet:media:${VALID_KEY}:${VALID_DIGEST}`,
    canonical: 'none',
  },
  { name: 'composite: empty prefix', text: `:${VALID_KEY}`, canonical: 'none' },
  { name: 'composite: two bare keys', text: `${VALID_KEY}:${VALID_KEY}`, canonical: 'none' },
  { name: 'composite: trailing colon', text: `wokenet:${VALID_KEY}:`, canonical: 'none' },
  { name: 'composite: no typed tail', text: 'wokenet:mainnet:media', canonical: 'none' },
  { name: 'composite: colon only', text: ':', canonical: 'none' },
  { name: 'composite: 200 colons', text: ':'.repeat(200), canonical: 'none' },
  {
    name: 'composite: near-miss tail (dirty padding bits)',
    text: `wokenet:${dirtyPaddingBits(VALID_DIGEST, BASE64URL_ALPHABET)}`,
    canonical: 'none',
  },
  {
    name: 'composite: cid tail is not a tail form',
    text: `wokenet:${VALID_CID}`,
    canonical: 'none',
  },

  /* unicode ---------------------------------------------------------------- */
  { name: 'unicode: empty string', text: '', canonical: 'none' },
  { name: 'unicode: single NUL', text: ' ', canonical: 'none' },
  { name: 'unicode: NUL inside text', text: `a ${VALID_KEY}`, canonical: 'none' },
  { name: 'unicode: C0 control run', text: '', canonical: 'none' },
  {
    name: 'unicode: lone high surrogate',
    text: '\ud800',
    canonical: 'none',
    utf8Carriable: false,
  },
  {
    name: 'unicode: lone low surrogate',
    text: '\udfff',
    canonical: 'none',
    utf8Carriable: false,
  },
  {
    name: 'unicode: reversed surrogate pair',
    text: '\udc00\ud800',
    canonical: 'none',
    utf8Carriable: false,
  },
  {
    name: 'unicode: lone surrogate beside astral',
    text: '\ud800\u{1d11e}',
    canonical: 'none',
    utf8Carriable: false,
  },
  {
    name: 'unicode: surrogate spliced into a valid key',
    text: `${VALID_KEY.slice(0, 20)}\ud83c${VALID_KEY.slice(20)}`,
    canonical: 'none',
    utf8Carriable: false,
  },
  { name: 'unicode: astral plane', text: '\u{1d11e}\u{10ffff}', canonical: 'none' },
  { name: 'unicode: NFC e-acute', text: 'é', canonical: 'none' },
  { name: 'unicode: NFD e-acute', text: 'é', canonical: 'none' },
  { name: 'unicode: NFC hangul', text: '한', canonical: 'none' },
  { name: 'unicode: NFD hangul', text: '한', canonical: 'none' },
  { name: 'unicode: replacement character', text: '�', canonical: 'none' },
  { name: 'unicode: byte order mark inside text', text: 'a﻿b', canonical: 'none' },
  { name: 'unicode: line and paragraph separators', text: '  ', canonical: 'none' },
  { name: 'unicode: right-to-left override', text: '‮key', canonical: 'none' },
  {
    name: 'unicode: combining mark appended to a key',
    text: `${VALID_KEY}́`,
    canonical: 'none',
  },
  { name: 'unicode: 64 KiB of a repeated char', text: 'a'.repeat(65_536), canonical: 'none' },
  { name: 'unicode: 16 Ki astral chars', text: '\u{1f331}'.repeat(16_384), canonical: 'none' },
];

/** Cases the UTF-8 dictionary can carry: everything but the unpaired-surrogate family. */
const CARRIABLE_CASES = STRING_CASES.filter(({ utf8Carriable }) => utf8Carriable !== false);
const SURROGATE_CASES = STRING_CASES.filter(({ utf8Carriable }) => utf8Carriable === false);

describe('near-miss recognizer forms', () => {
  it('classifies every case exactly as the case table declares', () => {
    const misclassified: string[] = [];
    for (const { name, text, canonical } of STRING_CASES) {
      const actual = {
        base58: isBase58Key32(text),
        digest: isMultibaseDigest32(text),
        cid: isCidV1RawSha256(text),
        timestamp: isExactMillisTimestamp(text),
        integer: isDecimalIntegerText(text),
      };
      const claimed = Object.entries(actual)
        .filter(([, held]) => held)
        .map(([form]) => form);
      const expected = canonical === 'none' ? [] : [canonical];
      if (claimed.join(',') !== expected.join(',')) {
        misclassified.push(
          `${name}: claimed [${claimed.join(', ')}], expected [${expected.join(', ')}]`,
        );
      }
    }
    expect(misclassified).toEqual([]);
  });

  it('round-trips every case byte-exactly as a bare JSON string', () => {
    for (const { name, text } of STRING_CASES) {
      roundTripMode(`bare string / ${name}`, encoder.encode(JSON.stringify(text)));
    }
  });

  it('takes the transcoded path for every carriable case', () => {
    const fellBack: string[] = [];
    for (const { name, text } of CARRIABLE_CASES) {
      // JSON.stringify is what the decoder rebuilds with, so this document is canonical by
      // construction. With the string itself carriable, the only remaining reason to decline is
      // a recognizer that mis-parses a non-canonical form into a token rendering differently —
      // which is exactly the bug the self-verify step would otherwise hide behind a silent,
      // correct, useless fallback. Hence this assertion and not just the round trip above.
      const mode = roundTripMode(`bare string / ${name}`, encoder.encode(JSON.stringify(text)));
      if (mode !== MiddleOutMode.Transcoded) {
        fellBack.push(name);
      }
    }
    expect(fellBack).toEqual([]);
  });

  it('declines losslessly for every case holding an unpaired surrogate', () => {
    // Documented limitation, asserted so it cannot change silently: the string dictionary is
    // UTF-8, UTF-8 has no encoding for an unpaired surrogate, and `JSON.parse('"\\ud800"')`
    // produces one. The whole document therefore stores verbatim. Losslessness holds; the
    // compression for that document does not.
    expect(SURROGATE_CASES.length).toBeGreaterThan(0);
    const wrongPath: string[] = [];
    for (const { name, text } of SURROGATE_CASES) {
      const mode = roundTripMode(`surrogate / ${name}`, encoder.encode(JSON.stringify(text)));
      if (mode !== MiddleOutMode.Passthrough) {
        wrongPath.push(name);
      }
    }
    expect(wrongPath).toEqual([]);
  });

  it('round-trips every case as an object value and an object key', () => {
    const fellBack: string[] = [];
    for (const { name, text } of STRING_CASES) {
      const asValue = encoder.encode(JSON.stringify({ v: text }));
      const asKey = encoder.encode(JSON.stringify({ [text]: 'v' }));
      const valueMode = roundTripMode(`value / ${name}`, asValue);
      const keyMode = roundTripMode(`key / ${name}`, asKey);
      const expected =
        STRING_CASES.find((entry) => entry.name === name)?.utf8Carriable === false
          ? MiddleOutMode.Passthrough
          : MiddleOutMode.Transcoded;
      if (valueMode !== expected) {
        fellBack.push(`value / ${name}`);
      }
      if (keyMode !== expected) {
        fellBack.push(`key / ${name}`);
      }
    }
    expect(fellBack).toEqual([]);
  });

  it('round-trips all cases together in one document, sharing one dictionary', () => {
    const all = JSON.stringify(STRING_CASES.map(({ text }) => text));
    roundTripMode('all string cases in one array', encoder.encode(all));
    const carriable = JSON.stringify(CARRIABLE_CASES.map(({ text }) => text));
    expect(roundTripMode('carriable cases in one array', encoder.encode(carriable))).toBe(
      MiddleOutMode.Transcoded,
    );
  });

  it('keeps NFC and NFD forms distinct rather than normalizing either', () => {
    const nfc = encoder.encode(JSON.stringify(['é', '한']));
    const nfd = encoder.encode(JSON.stringify(['é', '한']));
    expect(bytesEqual(nfc, nfd)).toBe(false);
    expect(roundTripMode('nfc', nfc)).toBe(MiddleOutMode.Transcoded);
    expect(roundTripMode('nfd', nfd)).toBe(MiddleOutMode.Transcoded);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Object keys that collide with the dictionary and with each other        */
/* -------------------------------------------------------------------------- */

describe('keys that collide with dictionary encoding', () => {
  it('round-trips a document where recognized forms are keys, values and a composite prefix', () => {
    const prefix = 'wokenet:mainnet:identity';
    // Integer-like keys are array indices, so JavaScript hoists them ahead of the rest in
    // ascending numeric order. The literal below is written in exactly that order so that
    // JSON.parse -> JSON.stringify is an identity on it and the transcoded path stays legal.
    const document =
      `{"0":"${prefix}","7":"${VALID_KEY}",` +
      `"${VALID_KEY}":"${VALID_KEY}",` +
      `"${VALID_DIGEST}":"${VALID_DIGEST}",` +
      `"${VALID_CID}":"${VALID_CID}",` +
      `"1970-01-01T00:00:00.000Z":"1970-01-01T00:00:00.000Z",` +
      `"${prefix}":"${prefix}:${VALID_KEY}:${VALID_DIGEST}",` +
      `"${prefix}:${VALID_KEY}":"${prefix}"}`;
    expect(roundTripMode('colliding keys', encoder.encode(document))).toBe(
      MiddleOutMode.Transcoded,
    );
  });

  it('round-trips prototype-sensitive keys without touching the prototype chain', () => {
    for (const key of [
      '__proto__',
      'constructor',
      'prototype',
      'toString',
      'valueOf',
      'hasOwnProperty',
    ]) {
      const document = encoder.encode(`{"${key}":{"a":1}}`);
      expect(roundTripMode(`prototype key ${key}`, document)).toBe(MiddleOutMode.Transcoded);
    }
  });

  it('round-trips duplicate keys in the raw text through passthrough', () => {
    for (const document of ['{"a":1,"a":2}', '{"a":1,"b":2,"a":3}', '{"a":1,"a":1}']) {
      expect(roundTripMode(`duplicate keys ${document}`, encoder.encode(document))).toBe(
        MiddleOutMode.Passthrough,
      );
    }
  });

  it('round-trips integer-like keys in an order JavaScript reorders', () => {
    for (const document of ['{"2":1,"1":2}', '{"b":1,"1":2}', '{"4294967295":1,"1":2}']) {
      roundTripMode(`reordered keys ${document}`, encoder.encode(document));
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Numeric edges                                                          */
/* -------------------------------------------------------------------------- */

/** `mode` is the expected path; asserting it is what stops a silent slide into passthrough. */
interface NumberCase {
  readonly text: string;
  readonly mode: MiddleOutMode;
}

const NUMBER_CASES: readonly NumberCase[] = [
  { text: '0', mode: MiddleOutMode.Transcoded },
  { text: '1', mode: MiddleOutMode.Transcoded },
  { text: '-1', mode: MiddleOutMode.Transcoded },
  { text: '-0', mode: MiddleOutMode.Passthrough },
  { text: '-0.0', mode: MiddleOutMode.Passthrough },
  { text: '0.0', mode: MiddleOutMode.Passthrough },
  { text: '9007199254740991', mode: MiddleOutMode.Transcoded },
  { text: '-9007199254740991', mode: MiddleOutMode.Transcoded },
  { text: '9007199254740992', mode: MiddleOutMode.Transcoded },
  { text: '-9007199254740992', mode: MiddleOutMode.Transcoded },
  { text: '9007199254740993', mode: MiddleOutMode.Passthrough },
  // JSON.parse rounds this to 18446744073709552000, whose canonical text differs from the input.
  { text: '18446744073709551616', mode: MiddleOutMode.Passthrough },
  { text: '1e+21', mode: MiddleOutMode.Transcoded },
  { text: '1e21', mode: MiddleOutMode.Passthrough },
  { text: '1E21', mode: MiddleOutMode.Passthrough },
  { text: '1e400', mode: MiddleOutMode.Passthrough },
  { text: '-1e400', mode: MiddleOutMode.Passthrough },
  { text: '1e-400', mode: MiddleOutMode.Passthrough },
  { text: '1.7976931348623157e+308', mode: MiddleOutMode.Transcoded },
  { text: '5e-324', mode: MiddleOutMode.Transcoded },
  { text: '0.1', mode: MiddleOutMode.Transcoded },
  { text: '0.10', mode: MiddleOutMode.Passthrough },
  { text: '1.50', mode: MiddleOutMode.Passthrough },
  { text: '0.30000000000000004', mode: MiddleOutMode.Transcoded },
  { text: '0.1234567890123456789', mode: MiddleOutMode.Passthrough },
  { text: '1e-7', mode: MiddleOutMode.Transcoded },
  { text: '0.000001', mode: MiddleOutMode.Transcoded },
  { text: '0.0000001', mode: MiddleOutMode.Passthrough },
  { text: '1000000000000000000000', mode: MiddleOutMode.Passthrough },
  { text: '123456789012345678901234567890', mode: MiddleOutMode.Passthrough },
  { text: '-123.456e-7', mode: MiddleOutMode.Passthrough },
  { text: '2147483648', mode: MiddleOutMode.Transcoded },
  { text: '4294967296', mode: MiddleOutMode.Transcoded },
  { text: '-2147483649', mode: MiddleOutMode.Transcoded },
];

describe('numeric edges', () => {
  it('round-trips every numeric edge byte-exactly on the expected path', () => {
    const wrongPath: string[] = [];
    for (const { text, mode } of NUMBER_CASES) {
      const bare = roundTripMode(`bare number ${text}`, encoder.encode(text));
      const nested = roundTripMode(`nested number ${text}`, encoder.encode(`{"n":[${text}]}`));
      if (bare !== mode || nested !== mode) {
        wrongPath.push(
          `${text}: bare ${String(bare)}, nested ${String(nested)}, want ${String(mode)}`,
        );
      }
    }
    expect(wrongPath).toEqual([]);
  });

  it('round-trips a wide sweep of exact-integer magnitudes through the transcoded path', () => {
    const fellBack: string[] = [];
    for (let bit = 0; bit <= 53; bit += 1) {
      for (const value of [2 ** bit - 1, 2 ** bit, 2 ** bit + 1]) {
        if (!Number.isSafeInteger(value)) {
          continue;
        }
        for (const signed of [value, -value]) {
          const text = String(signed);
          // `String(n)` is the canonical JSON number form for every safe integer, so these
          // documents are canonical and must never need the fallback.
          const mode = roundTripMode(`integer ${text}`, encoder.encode(text));
          if (mode !== MiddleOutMode.Transcoded && text !== '-0') {
            fellBack.push(text);
          }
        }
      }
    }
    expect(fellBack).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Structural extremes                                                    */
/* -------------------------------------------------------------------------- */

describe('structural extremes', () => {
  it('round-trips empty and singleton containers', () => {
    const documents = ['[]', '{}', '[[]]', '[{}]', '{"a":{}}', '{"a":[]}', '[null]', '{"":""}'];
    for (const document of documents) {
      expect(roundTripMode(`container ${document}`, encoder.encode(document))).toBe(
        MiddleOutMode.Transcoded,
      );
    }
  });

  it('round-trips a 10k-element array of each recognized form', () => {
    const size = 10_000;
    const forms: readonly (readonly [string, (index: number) => unknown])[] = [
      ['keys', (index) => base58Key(`bulk/k/${String(index)}`)],
      ['digests', (index) => digestText(`bulk/d/${String(index)}`)],
      ['cids', (index) => cidText(`bulk/c/${String(index)}`)],
      ['timestamps', (index) => isoAt(1_767_225_600_000 + index * 977)],
      ['integer strings', (index) => String(index * 65_537)],
      ['integers', (index) => index * 65_537],
      ['booleans and null', (index) => (index % 3 === 0 ? null : index % 3 === 1)],
    ];
    for (const [name, make] of forms) {
      const document = JSON.stringify(Array.from({ length: size }, (_, index) => make(index)));
      expect(roundTripMode(`10k ${name}`, encoder.encode(document))).toBe(MiddleOutMode.Transcoded);
    }
  });

  it('round-trips nesting on both sides of the depth limit', () => {
    const expectations: readonly (readonly [number, MiddleOutMode])[] = [
      [1, MiddleOutMode.Transcoded],
      [100, MiddleOutMode.Transcoded],
      [511, MiddleOutMode.Transcoded],
      [512, MiddleOutMode.Transcoded],
      [513, MiddleOutMode.Passthrough],
      [1_000, MiddleOutMode.Passthrough],
      [10_000, MiddleOutMode.Passthrough],
      [100_000, MiddleOutMode.Passthrough],
    ];
    const wrongPath: string[] = [];
    for (const [depth, expected] of expectations) {
      const wrappers: readonly (readonly [string, string])[] = [
        ['[', ']'],
        ['{"a":', '}'],
      ];
      for (const [open, close] of wrappers) {
        const document = `${open.repeat(depth)}1${close.repeat(depth)}`;
        const mode = roundTripMode(`depth ${String(depth)} ${open}`, encoder.encode(document));
        if (mode !== expected) {
          wrongPath.push(
            `depth ${String(depth)} ${open}: got ${String(mode)}, want ${String(expected)}`,
          );
        }
      }
    }
    expect(wrongPath).toEqual([]);
  });

  it('round-trips a 1 MiB string and a 1 MiB array', () => {
    expect(roundTripMode('1 MiB string', encoder.encode(JSON.stringify('x'.repeat(1 << 20))))).toBe(
      MiddleOutMode.Transcoded,
    );
    const array = JSON.stringify(Array.from({ length: 1 << 17 }, (_, index) => index % 10));
    expect(roundTripMode('1 MiB array', encoder.encode(array))).toBe(MiddleOutMode.Transcoded);
  });

  it('round-trips wide objects', () => {
    for (const width of [1, 2, 1_000, 20_000]) {
      const entries = Array.from({ length: width }, (_, index) => [`k${String(index)}`, index]);
      const document = JSON.stringify(Object.fromEntries(entries));
      roundTripMode(`object of width ${String(width)}`, encoder.encode(document));
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Byte-level attacks                                                     */
/* -------------------------------------------------------------------------- */

const BYTE_CASES: readonly (readonly [string, Uint8Array])[] = [
  ['empty input', new Uint8Array()],
  ['single zero byte', Uint8Array.of(0x00)],
  ['single 0xff byte', Uint8Array.of(0xff)],
  ['single ascii digit', encoder.encode('1')],
  ['single ascii letter', encoder.encode('a')],
  ['single quote', encoder.encode('"')],
  ['unterminated string', encoder.encode('"abc')],
  ['bare true with trailing space', encoder.encode('true ')],
  ['utf-8 BOM then JSON', Uint8Array.of(0xef, 0xbb, 0xbf, 0x6e, 0x75, 0x6c, 0x6c)],
  ['utf-16 BOM', Uint8Array.of(0xff, 0xfe, 0x6e, 0x00)],
  ['concatenated JSON documents', encoder.encode('{"a":1}{"b":2}')],
  ['newline-delimited JSON', encoder.encode('{"a":1}\n{"b":2}\n')],
  ['JSON with a trailing NUL', Uint8Array.of(0x6e, 0x75, 0x6c, 0x6c, 0x00)],
  ['lone continuation byte', Uint8Array.of(0x80)],
  ['truncated 2-byte sequence', Uint8Array.of(0xc3)],
  ['truncated 3-byte sequence', Uint8Array.of(0xe2, 0x82)],
  ['truncated 4-byte sequence', Uint8Array.of(0xf0, 0x9f, 0x8c)],
  ['overlong NUL encoding', Uint8Array.of(0xc0, 0x80)],
  ['overlong slash encoding', Uint8Array.of(0xe0, 0x80, 0xaf)],
  ['CESU-8 surrogate pair', Uint8Array.of(0xed, 0xa0, 0x80, 0xed, 0xb0, 0x80)],
  ['UTF-8 encoded lone surrogate', Uint8Array.of(0xed, 0xa0, 0x80)],
  ['5-byte sequence', Uint8Array.of(0xf8, 0x88, 0x80, 0x80, 0x80)],
  ['0xfe 0xff', Uint8Array.of(0xfe, 0xff)],
  [
    'raw HLS playlist',
    encoder.encode('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg0.m4s\n'),
  ],
  ['valid JSON wrapped in invalid utf-8', Uint8Array.of(0xff, 0x7b, 0x7d, 0xff)],
  ['gzip magic', Uint8Array.of(0x1f, 0x8b, 0x08, 0x00)],
  ['middle-out magic alone', encoder.encode('WMO1')],
  ['middle-out magic and mode byte', Uint8Array.of(0x57, 0x4d, 0x4f, 0x31, 0x00)],
  ['middle-out magic and unknown mode', Uint8Array.of(0x57, 0x4d, 0x4f, 0x31, 0x7f)],
];

describe('byte-level attacks', () => {
  it('round-trips every byte-level case byte-exactly', () => {
    for (const [name, input] of BYTE_CASES) {
      roundTripMode(name, input);
    }
  });

  it('re-wraps its own output and every truncation of it', () => {
    const inner = encodeMiddleOut(encoder.encode(JSON.stringify({ cid: VALID_CID })));
    roundTripMode('own container as input', inner);
    for (let length = 0; length <= inner.length; length += 1) {
      roundTripMode(`own container truncated to ${String(length)}`, inner.subarray(0, length));
    }
  });

  it('round-trips every single-byte prefix of a canonical envelope', () => {
    const full = encoder.encode(
      JSON.stringify({ author: VALID_KEY, cid: VALID_CID, createdAt: isoAt(1_767_225_600_000) }),
    );
    for (let length = 0; length <= full.length; length += 1) {
      roundTripMode(`prefix of length ${String(length)}`, full.subarray(0, length));
    }
  });

  it('round-trips every byte value as a one-byte input', () => {
    for (let byte = 0; byte <= 0xff; byte += 1) {
      roundTripMode(`single byte 0x${byte.toString(16)}`, Uint8Array.of(byte));
    }
  });

  it('round-trips all 65536 two-byte inputs exhaustively', () => {
    // Exhaustive rather than sampled: the two-byte domain is small enough to close completely,
    // and it covers every truncated multi-byte UTF-8 lead, every one-character JSON fragment,
    // and every malformed pair at once.
    const pair = new Uint8Array(2);
    for (let first = 0; first <= 0xff; first += 1) {
      for (let second = 0; second <= 0xff; second += 1) {
        pair[0] = first;
        pair[1] = second;
        roundTripMode(`two bytes ${String(first)},${String(second)}`, pair);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Corrupted containers                                                   */
/* -------------------------------------------------------------------------- */

describe('corrupted containers', () => {
  const originals: readonly (readonly [string, Uint8Array])[] = [
    ['transcoded', encoder.encode(JSON.stringify({ a: VALID_KEY, b: [1, 2, 3], c: VALID_CID }))],
    ['passthrough', encoder.encode('#EXTM3U\n#EXT-X-VERSION:7\n')],
    ['empty passthrough', new Uint8Array()],
  ];

  /**
   * The one thing a decoder must never do is fail in an untyped way. Returning the original
   * bytes is fine (the mutation was in slack), and throwing `MiddleOutFormatError` is fine
   * (the mutation was detected); anything else — a `TypeError` from an index, a `RangeError`
   * from an allocation the header asked for — is a bug in the bounds checking.
   */
  function expectTypedFailureOrOriginal(label: string, mutated: Uint8Array, original: Uint8Array) {
    let decoded: Uint8Array;
    try {
      decoded = decodeMiddleOut(mutated);
    } catch (error) {
      if (!(error instanceof MiddleOutFormatError)) {
        throw new Error(
          `${label}: decodeMiddleOut threw an untyped ${describeError(error)}\n  ${hex(mutated)}`,
        );
      }
      return;
    }
    if (!bytesEqual(decoded, original)) {
      // Accepted: the container carries no checksum, so a mutation inside the payload can
      // decode to different-but-well-formed bytes. What is asserted is that it did not crash
      // and did not read out of bounds.
      expect(decoded.length).toBeGreaterThanOrEqual(0);
    }
  }

  it('never fails in an untyped way on any single-byte truncation', () => {
    for (const [name, input] of originals) {
      const container = encodeMiddleOut(input);
      for (let length = 0; length < container.length; length += 1) {
        expectTypedFailureOrOriginal(
          `${name} truncated to ${String(length)}`,
          container.subarray(0, length),
          input,
        );
      }
    }
  });

  it('never fails in an untyped way on any single-byte substitution', () => {
    const rng = makeRng(0x0bad_c0de);
    for (const [name, input] of originals) {
      const container = encodeMiddleOut(input);
      for (let position = 0; position < container.length; position += 1) {
        for (const replacement of [0x00, 0xff, 0x80, 0x7f, rng() & 0xff]) {
          const mutated = container.slice();
          mutated[position] = replacement;
          expectTypedFailureOrOriginal(
            `${name} byte ${String(position)} := 0x${replacement.toString(16)}`,
            mutated,
            input,
          );
        }
      }
    }
  });

  it('never fails in an untyped way on appended garbage', () => {
    for (const [name, input] of originals) {
      const container = encodeMiddleOut(input);
      for (const extra of [1, 2, 8, 64]) {
        const mutated = new Uint8Array(container.length + extra);
        mutated.set(container, 0);
        mutated.fill(0xaa, container.length);
        expectTypedFailureOrOriginal(`${name} + ${String(extra)} bytes`, mutated, input);
      }
    }
  });

  it('never fails in an untyped way on a hand-built hostile header', () => {
    const hostile: readonly Uint8Array[] = [
      // Transcoded mode with a declared payload length of 2^53 - 1 and no body.
      Uint8Array.of(0x57, 0x4d, 0x4f, 0x31, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f),
      // Passthrough mode declaring 2^49 bytes it does not have.
      Uint8Array.of(0x57, 0x4d, 0x4f, 0x31, 0x00, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01),
      // Transcoded mode with a payload length below the structural minimum.
      Uint8Array.of(0x57, 0x4d, 0x4f, 0x31, 0x01, 0x01),
      // Non-minimal varint in the length field.
      Uint8Array.of(0x57, 0x4d, 0x4f, 0x31, 0x00, 0x80, 0x00),
      // A varint that never terminates.
      Uint8Array.of(0x57, 0x4d, 0x4f, 0x31, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
    ];
    for (let index = 0; index < hostile.length; index += 1) {
      const mutated = hostile[index] ?? new Uint8Array();
      expectTypedFailureOrOriginal(`hostile header ${String(index)}`, mutated, new Uint8Array());
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 7. Bulk deterministic fuzz                                                */
/* -------------------------------------------------------------------------- */

/** Builds hostile JSON *text* directly, so non-canonical spellings survive into the input. */
function fuzzJsonText(rng: () => number, depth: number): string {
  const NON_CANONICAL_NUMBERS = ['-0', '1e21', '0.10', '1E2', '1e400', '9007199254740993', '00.5'];
  const choice = rng() % 16;
  if (depth >= 6 || choice < 9) {
    switch (rng() % 10) {
      case 0:
        return 'null';
      case 1:
        return rng() % 2 === 0 ? 'true' : 'false';
      case 2:
        return String((rng() % 2_000_000) - 1_000_000);
      case 3:
        return NON_CANONICAL_NUMBERS[rng() % NON_CANONICAL_NUMBERS.length] ?? '0';
      case 4:
        return JSON.stringify(base58Key(`fuzz/${String(rng())}`));
      case 5:
        return JSON.stringify(digestText(`fuzz/${String(rng())}`));
      case 6:
        return JSON.stringify(cidText(`fuzz/${String(rng())}`));
      case 7:
        return JSON.stringify(isoAt(rng() % 4_000_000_000_000));
      case 8: {
        const piece = STRING_CASES[rng() % STRING_CASES.length];
        return JSON.stringify(piece === undefined ? '' : piece.text);
      }
      default:
        return JSON.stringify(
          `woke:id:v1:${base58Key(`fuzz/p/${String(rng())}`)}:${digestText(`fuzz/q/${String(rng())}`)}`,
        );
    }
  }
  const size = rng() % 5;
  if (choice < 13) {
    const items: string[] = [];
    for (let index = 0; index < size; index += 1) {
      items.push(fuzzJsonText(rng, depth + 1));
    }
    return `[${items.join(',')}]`;
  }
  const entries: string[] = [];
  for (let index = 0; index < size; index += 1) {
    const keyCase = STRING_CASES[rng() % STRING_CASES.length];
    const key = rng() % 2 === 0 ? `k${String(rng() % 1000)}` : (keyCase?.text ?? 'k');
    entries.push(`${JSON.stringify(key)}:${fuzzJsonText(rng, depth + 1)}`);
  }
  return `{${entries.join(',')}}`;
}

describe('bulk deterministic fuzz', () => {
  it('round-trips 3000 hostile JSON texts byte-exactly', () => {
    for (let seed = 1; seed <= 3_000; seed += 1) {
      const rng = makeRng(seed * 0x9e37_79b9);
      const text = fuzzJsonText(rng, 0);
      roundTripMode(`json fuzz seed ${String(seed)}: ${text.slice(0, 120)}`, encoder.encode(text));
    }
  });

  it('round-trips 2000 pseudo-random byte blobs byte-exactly', () => {
    const rng = makeRng(0x5eed_face);
    for (let index = 0; index < 2_000; index += 1) {
      const length = rng() % 512;
      const blob = new Uint8Array(length);
      for (let position = 0; position < length; position += 1) {
        blob[position] = rng() & 0xff;
      }
      roundTripMode(`byte blob ${String(index)}`, blob);
    }
  });

  it('round-trips 1500 single-byte mutations of a canonical envelope byte-exactly', () => {
    const rng = makeRng(0xfeed_1234);
    const base = encoder.encode(
      JSON.stringify({
        author: `woke:id:v1:${VALID_KEY}:${VALID_DIGEST}`,
        createdAt: isoAt(1_767_225_600_777),
        segments: Array.from({ length: 12 }, (_, index) => cidText(`m/${String(index)}`)),
        seq: '41',
      }),
    );
    for (let index = 0; index < 1_500; index += 1) {
      const mutated = base.slice();
      const position = rng() % mutated.length;
      mutated[position] = rng() & 0xff;
      roundTripMode(`envelope mutation ${String(index)} at ${String(position)}`, mutated);
    }
  });

  it('round-trips 1000 random truncations and splices of a canonical envelope', () => {
    const rng = makeRng(0x1234_5678);
    const base = encoder.encode(
      JSON.stringify({ ids: Array.from({ length: 20 }, (_, i) => base58Key(`t/${String(i)}`)) }),
    );
    for (let index = 0; index < 1_000; index += 1) {
      const start = rng() % base.length;
      const end = start + (rng() % (base.length - start + 1));
      roundTripMode(
        `splice ${String(index)} [${String(start)},${String(end)})`,
        base.subarray(start, end),
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 8. Determinism and freedom from ambient state                             */
/* -------------------------------------------------------------------------- */

describe('determinism', () => {
  it('produces byte-identical containers for repeated encodes of the same input', () => {
    const inputs = [
      encoder.encode(JSON.stringify({ a: VALID_KEY, b: VALID_CID, c: isoAt(1_767_225_600_000) })),
      encoder.encode('#EXTM3U\n'),
      new Uint8Array(),
      encoder.encode(JSON.stringify(STRING_CASES.map(({ text }) => text))),
    ];
    for (const input of inputs) {
      const first = encodeMiddleOut(input);
      const second = encodeMiddleOut(input);
      expect(bytesEqual(first, second), `encode is not deterministic for ${hex(input)}`).toBe(true);
    }
  });

  it('is unaffected by the position of the input inside a larger buffer', () => {
    const payload = encoder.encode(JSON.stringify({ cid: VALID_CID, key: VALID_KEY }));
    const padded = new Uint8Array(payload.length + 2_000);
    padded.fill(0x5a);
    padded.set(payload, 977);
    const view = padded.subarray(977, 977 + payload.length);
    expect(bytesEqual(encodeMiddleOut(view), encodeMiddleOut(payload))).toBe(true);
    expect(bytesEqual(decodeMiddleOut(encodeMiddleOut(view)), payload)).toBe(true);
  });

  it('does not mutate its input', () => {
    const input = encoder.encode(JSON.stringify({ a: VALID_KEY }));
    const snapshot = input.slice();
    encodeMiddleOut(input);
    decodeMiddleOut(encodeMiddleOut(input));
    expect(bytesEqual(input, snapshot)).toBe(true);
  });

  it('produces a decoded buffer that does not alias the container', () => {
    const input = encoder.encode('#EXTM3U\n#EXT-X-VERSION:7\n');
    const container = encodeMiddleOut(input);
    const decoded = decodeMiddleOut(container);
    container.fill(0x00);
    expect(bytesEqual(decoded, input)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 9. Anti-vacuity: the codec must actually do the work it claims            */
/* -------------------------------------------------------------------------- */

describe('the transcoded path is not vacuous', () => {
  /** A canonical envelope corpus: sorted keys, no whitespace, canonical number forms. */
  function envelopeCorpus(count: number): string {
    const documents = Array.from({ length: count }, (_, index) => ({
      author: `woke:id:v1:${base58Key(`a/${String(index)}`)}:${digestText(`b/${String(index)}`)}`,
      contentDigest: digestText(`c/${String(index)}`),
      createdAt: isoAt(1_767_225_600_000 + index * 131_071),
      kind: 'wokenet.media.manifest.v1',
      seq: String(index + 1),
      segments: Array.from({ length: 8 }, (_, s) => cidText(`s/${String(index)}/${String(s)}`)),
    }));
    return JSON.stringify(documents);
  }

  it('beats brotli-11 on a canonical envelope corpus, with the win measured not claimed', () => {
    const input = encoder.encode(envelopeCorpus(300));
    expect(roundTripMode('envelope corpus', input)).toBe(MiddleOutMode.Transcoded);
    const middleOut = encodeMiddleOut(input).length;
    const brotli = brotliMax(input).length;
    expect(
      middleOut,
      `middle-out ${String(middleOut)} B must be under brotli-11 ${String(brotli)} B ` +
        `(input ${String(input.length)} B)`,
    ).toBeLessThan(brotli);
  });

  /**
   * Reaches the information floor, and records how little of the margin brotli leaves.
   *
   * This is the finding worth pinning: a strong entropy coder *does* recover most of a base-N
   * expansion. brotli's Huffman/context stage prices a base58 character near log2(58) = 5.86
   * bits instead of 8, so on a corpus of nothing but 32-byte keys it lands within a few percent
   * of the 32-bytes-per-value floor on its own. Parsing inward still wins on every form measured
   * here, but by roughly 1-2% on the base-N forms, not by the large factor "encoded randomness
   * is incompressible" would imply. The assertions are therefore: strictly smaller than
   * brotli-11 (the real claim), and within 5% of the floor (the real ceiling on any further
   * gain). The measured margin is printed so a regression is legible rather than mysterious.
   */
  it('reaches the information floor on each recognized form, and beats brotli-11 doing it', async ({
    annotate,
  }) => {
    const count = 2_000;
    const forms: readonly (readonly [string, readonly string[]])[] = [
      ['base58 keys', Array.from({ length: count }, (_, i) => base58Key(`w/k/${String(i)}`))],
      ['digests', Array.from({ length: count }, (_, i) => digestText(`w/d/${String(i)}`))],
      ['cids', Array.from({ length: count }, (_, i) => cidText(`w/c/${String(i)}`))],
    ];
    // 32 raw bytes per value is the incompressible payload every codec must ultimately carry.
    const floor = count * 32;
    for (const [name, values] of forms) {
      const input = encoder.encode(JSON.stringify(values));
      expect(roundTripMode(name, input)).toBe(MiddleOutMode.Transcoded);
      const middleOut = encodeMiddleOut(input).length;
      const brotli = brotliMax(input).length;
      const report = {
        form: name,
        inputBytes: input.length,
        brotli11Bytes: brotli,
        middleOutBytes: middleOut,
        informationFloorBytes: floor,
        middleOutOverFloor: Number((middleOut / floor).toFixed(4)),
        brotli11OverFloor: Number((brotli / floor).toFixed(4)),
        middleOutOverBrotli11: Number((middleOut / brotli).toFixed(4)),
      };
      await annotate(JSON.stringify(report), 'notice');
      expect(middleOut, JSON.stringify(report)).toBeLessThan(brotli);
      expect(middleOut, JSON.stringify(report)).toBeLessThan(floor * 1.05);
    }
  });

  /**
   * KNOWN GAP, measured here so it cannot drift: the transcoded path is not compared against
   * passthrough before being returned.
   *
   * `encodeMiddleOut` returns the transcoded container whenever it self-verifies, without asking
   * whether passthrough would have been smaller. On a short document that *is* parseable but
   * whose content is incompressible, brotli's stream framing costs more than it saves, so the
   * container comes out a few bytes larger than storing the raw input would have been. Sibling
   * code already does the comparison this path skips — `chooseEncoding` in `src/delta.ts` takes
   * the delta only when it is strictly smaller than the standalone baseline. The one-line fix
   * here is the same shape: return whichever of the two verified containers is shorter.
   *
   * Until then this test bounds the damage and prints the worst case, so the regression is a
   * known, quantified cost and not a surprise.
   */
  it('bounds the expansion the transcoded path can cost on small incompressible documents', async ({
    annotate,
  }) => {
    const rng = makeRng(0x5123_4567);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let worstExpansion = 0;
    let worstCase = '';
    let regressions = 0;
    let trials = 0;
    for (let trial = 0; trial < 1_500; trial += 1) {
      let text = '';
      const length = 1 + (rng() % 200);
      for (let index = 0; index < length; index += 1) {
        text += alphabet.charAt(rng() % alphabet.length);
      }
      for (const document of [JSON.stringify(text), JSON.stringify({ a: text })]) {
        const input = encoder.encode(document);
        const container = encodeMiddleOut(input);
        const passthrough = encodeMiddleOut(input, { forcePassthrough: true });
        trials += 1;
        const expansion = container.length - passthrough.length;
        if (expansion > 0) {
          regressions += 1;
          if (expansion > worstExpansion) {
            worstExpansion = expansion;
            worstCase = document.slice(0, 80);
          }
        }
      }
    }
    await annotate(
      JSON.stringify({ trials, regressions, worstExpansionBytes: worstExpansion, worstCase }),
      'notice',
    );
    expect(worstExpansion, `worst case: ${worstCase}`).toBeLessThanOrEqual(16);
  });

  it('costs only container overhead when it declines', () => {
    const input = encoder.encode('#EXTM3U\n#EXT-X-TARGETDURATION:4\n');
    const container = encodeMiddleOut(input);
    expect(readMiddleOutMode(container)).toBe(MiddleOutMode.Passthrough);
    // magic (4) + mode (1) + one varint length byte for a body under 128 bytes.
    expect(container.length).toBe(input.length + 6);
  });
});

/* -------------------------------------------------------------------------- */
/* 10. Layer 1: chunking invariants under attack                             */
/* -------------------------------------------------------------------------- */

/** Deterministic byte-pattern generators chosen to stress boundary detection specifically. */
const PATTERNS: readonly (readonly [string, (length: number) => Uint8Array])[] = [
  ['zeros', (length) => new Uint8Array(length)],
  ['ones', (length) => new Uint8Array(length).fill(0xff)],
  [
    'counter',
    (length) => {
      const out = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        out[index] = index & 0xff;
      }
      return out;
    },
  ],
  [
    'period 31',
    (length) => {
      const out = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        out[index] = (index % 31) * 7;
      }
      return out;
    },
  ],
  [
    'period 32',
    (length) => {
      const out = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        out[index] = (index % 32) * 5;
      }
      return out;
    },
  ],
  [
    'high entropy',
    (length) => {
      const rng = makeRng(0x00c0_ffee);
      const out = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        out[index] = rng() & 0xff;
      }
      return out;
    },
  ],
  [
    'runs and entropy',
    (length) => {
      const rng = makeRng(0x00d0_0d1e);
      const out = new Uint8Array(length);
      let index = 0;
      while (index < length) {
        const run = 1 + (rng() % 4_096);
        const value = rng() & 0xff;
        const literal = rng() % 2 === 0;
        for (let step = 0; step < run && index < length; step += 1) {
          out[index] = literal ? value : rng() & 0xff;
          index += 1;
        }
      }
      return out;
    },
  ],
  [
    'ascii json',
    (length) => encoder.encode(JSON.stringify(cidText('chunk')).repeat(length)).subarray(0, length),
  ],
];

const OPTION_SETS: readonly (readonly [string, ChunkingOptions | undefined])[] = [
  ['defaults', undefined],
  ['tiny', { minSize: 4, avgSize: 8, maxSize: 16 }],
  ['small', { minSize: 64, avgSize: 256, maxSize: 1_024 }],
  ['non-power-of-two', { minSize: 100, avgSize: 300, maxSize: 700 }],
  ['min 1', { minSize: 1, avgSize: 8, maxSize: 9 }],
  ['wide', { minSize: 1_024, avgSize: 65_536, maxSize: 1 << 20 }],
];

/** Returns the list of violated invariants; empty means the chunking is sound. */
function chunkingViolations(bytes: Uint8Array, options: ChunkingOptions | undefined): string[] {
  const resolved = resolveChunkingOptions(options);
  const chunks: Chunk[] = chunkBytes(bytes, options);
  const problems: string[] = [];

  if (bytes.length === 0) {
    if (chunks.length !== 0) {
      problems.push(`empty input produced ${String(chunks.length)} chunks`);
    }
    return problems;
  }
  if (chunks.length === 0) {
    problems.push('non-empty input produced no chunks');
    return problems;
  }
  if (chunks[0]?.offset !== 0) {
    problems.push(`first chunk starts at ${String(chunks[0]?.offset)}, not 0`);
  }

  let cursor = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk === undefined) {
      problems.push(`chunk ${String(index)} is missing`);
      break;
    }
    if (chunk.offset !== cursor) {
      problems.push(
        `chunk ${String(index)} starts at ${String(chunk.offset)}, expected ${String(cursor)} ` +
          `(gap or overlap of ${String(chunk.offset - cursor)} bytes)`,
      );
    }
    if (chunk.length <= 0) {
      problems.push(`chunk ${String(index)} has length ${String(chunk.length)}`);
    }
    if (chunk.length > resolved.maxSize) {
      problems.push(`chunk ${String(index)} length ${String(chunk.length)} exceeds maxSize`);
    }
    if (index < chunks.length - 1 && chunk.length < resolved.minSize) {
      problems.push(
        `non-final chunk ${String(index)} length ${String(chunk.length)} is under minSize`,
      );
    }
    cursor = chunk.offset + chunk.length;
  }
  if (cursor !== bytes.length) {
    problems.push(`chunks cover ${String(cursor)} of ${String(bytes.length)} bytes`);
  }

  const rebuilt = new Uint8Array(bytes.length);
  for (const chunk of chunks) {
    rebuilt.set(bytes.subarray(chunk.offset, chunk.offset + chunk.length), chunk.offset);
  }
  if (!bytesEqual(rebuilt, bytes)) {
    problems.push('reassembly from chunk ranges is not byte-exact');
  }
  return problems;
}

describe('chunking invariants under attack', () => {
  it('holds for every pattern, option set and boundary-adjacent length', () => {
    const failures: string[] = [];
    for (const [optionName, options] of OPTION_SETS) {
      const resolved = resolveChunkingOptions(options);
      const lengths = new Set<number>([
        0,
        1,
        2,
        31,
        32,
        33,
        resolved.minSize - 1,
        resolved.minSize,
        resolved.minSize + 1,
        resolved.avgSize - 1,
        resolved.avgSize,
        resolved.avgSize + 1,
        resolved.maxSize - 1,
        resolved.maxSize,
        resolved.maxSize + 1,
        resolved.maxSize * 2,
        resolved.maxSize * 2 + 1,
        resolved.maxSize * 3 + 7,
      ]);
      for (const [patternName, make] of PATTERNS) {
        for (const length of lengths) {
          if (length < 0 || length > 4 << 20) {
            continue;
          }
          const problems = chunkingViolations(make(length), options);
          for (const problem of problems) {
            failures.push(`${optionName}/${patternName}/len ${String(length)}: ${problem}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('holds for 500 pseudo-random lengths and contents', () => {
    const rng = makeRng(0x0abc_def0);
    const failures: string[] = [];
    for (let index = 0; index < 500; index += 1) {
      const length = rng() % 300_000;
      const bytes = new Uint8Array(length);
      for (let position = 0; position < length; position += 1) {
        bytes[position] = rng() % (1 + (rng() % 256));
      }
      const optionSet = OPTION_SETS[rng() % OPTION_SETS.length];
      const problems = chunkingViolations(bytes, optionSet?.[1]);
      for (const problem of problems) {
        failures.push(
          `case ${String(index)} (${optionSet?.[0] ?? '?'}, ${String(length)} B): ${problem}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('is deterministic and position-independent', () => {
    const rng = makeRng(0x00fe_edee);
    const payload = new Uint8Array(400_000);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = rng() & 0xff;
    }
    const direct = chunkBytes(payload);
    expect(chunkBytes(payload)).toEqual(direct);

    const padded = new Uint8Array(payload.length + 12_345);
    padded.fill(0x33);
    padded.set(payload, 4_099);
    const view = padded.subarray(4_099, 4_099 + payload.length);
    expect(chunkBytes(view)).toEqual(direct);
  });

  it('resynchronizes after a one-byte insertion where fixed-size blocking cannot', () => {
    const rng = makeRng(0x00ab_cdef);
    const original = new Uint8Array(2 << 20);
    for (let index = 0; index < original.length; index += 1) {
      original[index] = rng() & 0xff;
    }
    const edited = new Uint8Array(original.length + 1);
    edited[0] = 0x2a;
    edited.set(original, 1);

    const digestOf = (bytes: Uint8Array): string =>
      createHash('sha256').update(bytes).digest('hex');

    const stored = new Set(
      chunkBytes(original).map((chunk) =>
        digestOf(original.subarray(chunk.offset, chunk.offset + chunk.length)),
      ),
    );
    const editedChunks = chunkBytes(edited);
    let cdcMatched = 0;
    for (const chunk of editedChunks) {
      if (stored.has(digestOf(edited.subarray(chunk.offset, chunk.offset + chunk.length)))) {
        cdcMatched += chunk.length;
      }
    }

    const blockSize = DEFAULT_CHUNKING_OPTIONS.avgSize;
    const fixedStored = new Set<string>();
    for (let offset = 0; offset < original.length; offset += blockSize) {
      fixedStored.add(
        digestOf(original.subarray(offset, Math.min(offset + blockSize, original.length))),
      );
    }
    let fixedMatched = 0;
    for (let offset = 0; offset < edited.length; offset += blockSize) {
      const end = Math.min(offset + blockSize, edited.length);
      if (fixedStored.has(digestOf(edited.subarray(offset, end)))) {
        fixedMatched += end - offset;
      }
    }

    const detail =
      `content-defined recovered ${String(cdcMatched)}/${String(edited.length)} B, ` +
      `fixed-size recovered ${String(fixedMatched)}/${String(edited.length)} B`;
    expect(cdcMatched / edited.length, detail).toBeGreaterThan(0.5);
    expect(fixedMatched, detail).toBeLessThan(cdcMatched);
  });
});
