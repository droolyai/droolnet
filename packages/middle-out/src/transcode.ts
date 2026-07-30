/**
 * Middle-out layer 2: typed middle-representation transcoding.
 *
 * Protocol envelopes, media manifests and playlists are mostly text-encoded
 * randomness (base58 keys, multibase digests, CIDs, composite identifiers,
 * decimal-string integers, exact-millisecond timestamps) wrapped in a small,
 * highly repetitive JSON skeleton. The pipeline parses *inward* to a token
 * stream over raw bytes plus a shared string dictionary, then entropy-codes
 * *outward* with brotli.
 *
 * Container layout:
 *
 *     "WMO1" <mode>
 *     mode 0 (passthrough): <varint byteLength> <raw input bytes>
 *     mode 1 (transcoded):  <varint payloadLength> <brotli(payload)>
 *
 *     payload: <varint dictCount> (<varint utf8Len> <utf8>)*dictCount <value>
 *     value:   <tag> <tag-specific payload>
 *
 * Losslessness is structural rather than hoped for: {@link encodeMiddleOut}
 * decodes its own output and compares it byte-for-byte with its input before
 * returning, and degrades to passthrough on any mismatch. A transcoder bug can
 * therefore cost bytes, never data.
 */

import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';
import {
  readStringToken,
  recognizeString,
  renderStringToken,
  TAG_ARRAY,
  TAG_FALSE,
  TAG_NEGINT,
  TAG_NULL,
  TAG_NUMBER_TEXT,
  TAG_OBJECT,
  TAG_STRING_REF,
  TAG_TRUE,
  TAG_UINT,
  writeStringToken,
} from './recognizers.js';
import { ByteReader, ByteWriter, decodeUtf8, encodeUtf8 } from './varint.js';

/** `WMO1` — WokeNet Middle-Out, container version 1. */
const MAGIC = Uint8Array.of(0x57, 0x4d, 0x4f, 0x31);

/**
 * Bounded so a transcoded container is always decodable without exhausting the
 * stack. Documents nested deeper than this fall back to passthrough.
 */
const MAX_DEPTH = 512;

/** Smallest legal transcoded payload: an empty dictionary plus one token byte. */
const MIN_PAYLOAD_BYTES = 2;

export const MiddleOutMode = {
  /** Raw input bytes, stored verbatim behind the container header. */
  Passthrough: 0,
  /** Typed token stream, brotli-coded. */
  Transcoded: 1,
} as const;

export type MiddleOutMode = (typeof MiddleOutMode)[keyof typeof MiddleOutMode];

/** Thrown by {@link decodeMiddleOut} for malformed, truncated or foreign containers. */
export class MiddleOutFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MiddleOutFormatError';
  }
}

export interface EncodeOptions {
  /** Brotli quality, 0-11. Defaults to 11 (maximum). */
  readonly quality?: number;
  /** Skip transcoding entirely. Useful for measuring the pipeline against itself. */
  readonly forcePassthrough?: boolean;
}

/** JSON value tree, as produced by `JSON.parse` and consumed by `JSON.stringify`. */
export type JsonValue = null | boolean | number | string | JsonArray | JsonObject;

export type JsonArray = readonly JsonValue[];

/** An index signature rather than `Record`, which cannot express the recursion. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** True when `bytes` starts with the middle-out magic and a mode byte we know. */
export function isMiddleOutContainer(bytes: Uint8Array): boolean {
  return readMiddleOutMode(bytes) !== null;
}

/** The container's mode, or `null` if `bytes` is not a middle-out container. */
export function readMiddleOutMode(bytes: Uint8Array): MiddleOutMode | null {
  if (bytes.length < MAGIC.length + 1) {
    return null;
  }
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (bytes[index] !== MAGIC[index]) {
      return null;
    }
  }
  const mode = bytes[MAGIC.length];
  if (mode === MiddleOutMode.Passthrough || mode === MiddleOutMode.Transcoded) {
    return mode;
  }
  return null;
}

/**
 * Encodes `input` into a middle-out container. Never throws for any input:
 * passthrough is always available.
 *
 * Re-canonicalization caveat: the transcoded form is rebuilt on decode with
 * `JSON.stringify`, which only reproduces the input byte-for-byte when the input
 * was already canonical (no insignificant whitespace, key order matching
 * JavaScript's own-property order, number forms matching `String(n)`). The
 * self-verify step below makes that safe rather than dangerous — non-canonical
 * input simply lands in passthrough.
 */
export function encodeMiddleOut(input: Uint8Array, options?: EncodeOptions): Uint8Array {
  if (options?.forcePassthrough === true) {
    return passthroughContainer(input);
  }
  const quality = options?.quality ?? zlibConstants.BROTLI_MAX_QUALITY;

  let candidate: Uint8Array;
  try {
    candidate = transcodedContainer(input, quality);
  } catch {
    return passthroughContainer(input);
  }

  try {
    if (!bytesEqual(decodeMiddleOut(candidate), input)) {
      return passthroughContainer(input);
    }
  } catch {
    return passthroughContainer(input);
  }
  return candidate;
}

/** Exact inverse of {@link encodeMiddleOut}. */
export function decodeMiddleOut(container: Uint8Array): Uint8Array {
  try {
    return decodeContainer(container);
  } catch (error) {
    if (error instanceof MiddleOutFormatError) {
      throw error;
    }
    throw new MiddleOutFormatError('malformed middle-out container', { cause: error });
  }
}

/* -------------------------------------------------------------------------- */
/* Container framing                                                          */
/* -------------------------------------------------------------------------- */

function passthroughContainer(input: Uint8Array): Uint8Array {
  const writer = new ByteWriter(input.length + MAGIC.length + 10);
  writer.pushBytes(MAGIC);
  writer.pushByte(MiddleOutMode.Passthrough);
  writer.pushVarint(input.length);
  writer.pushBytes(input);
  return writer.toUint8Array();
}

function transcodedContainer(input: Uint8Array, quality: number): Uint8Array {
  const value: unknown = JSON.parse(decodeUtf8(input));

  const context: EncodeContext = {
    tokens: new ByteWriter(Math.max(64, input.length)),
    dictionary: [],
    index: new Map<string, number>(),
  };
  writeValue(context, value, 0);

  const payload = new ByteWriter(context.tokens.length + 64);
  payload.pushVarint(context.dictionary.length);
  for (const entry of context.dictionary) {
    payload.pushString(entry);
  }
  payload.pushBytes(context.tokens.toUint8Array());
  const rawPayload = payload.toUint8Array();

  const compressed = brotliCompressSync(rawPayload, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: quality,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: rawPayload.length,
    },
  });

  const container = new ByteWriter(compressed.length + MAGIC.length + 10);
  container.pushBytes(MAGIC);
  container.pushByte(MiddleOutMode.Transcoded);
  container.pushVarint(rawPayload.length);
  container.pushBytes(compressed);
  return container.toUint8Array();
}

function decodeContainer(container: Uint8Array): Uint8Array {
  const mode = readMiddleOutMode(container);
  if (mode === null) {
    throw new MiddleOutFormatError('not a middle-out container');
  }
  const reader = new ByteReader(container, MAGIC.length + 1);

  if (mode === MiddleOutMode.Passthrough) {
    const byteLength = reader.readVarint();
    const raw = reader.readBytes(byteLength);
    if (reader.remaining !== 0) {
      throw new MiddleOutFormatError(`${reader.remaining} trailing bytes after passthrough body`);
    }
    return raw.slice();
  }

  const payloadLength = reader.readVarint();
  if (payloadLength < MIN_PAYLOAD_BYTES) {
    throw new MiddleOutFormatError(`declared payload length ${payloadLength} is too small`);
  }
  const compressed = reader.readBytes(reader.remaining);
  const payload = brotliDecompressSync(compressed, { maxOutputLength: payloadLength });
  if (payload.length !== payloadLength) {
    throw new MiddleOutFormatError(
      `payload length mismatch: declared ${payloadLength}, decompressed ${payload.length}`,
    );
  }

  const payloadReader = new ByteReader(payload);
  const dictionaryLength = payloadReader.readVarint();
  const dictionary: string[] = [];
  for (let index = 0; index < dictionaryLength; index += 1) {
    dictionary.push(payloadReader.readString());
  }
  const value = readValue(payloadReader, dictionary, 0);
  if (payloadReader.remaining !== 0) {
    throw new MiddleOutFormatError(
      `${payloadReader.remaining} trailing bytes after the token stream`,
    );
  }
  return encodeUtf8(JSON.stringify(value));
}

/* -------------------------------------------------------------------------- */
/* Inward: JSON tree -> token stream                                          */
/* -------------------------------------------------------------------------- */

interface EncodeContext {
  readonly tokens: ByteWriter;
  readonly dictionary: string[];
  readonly index: Map<string, number>;
}

function internString(context: EncodeContext, text: string): number {
  const existing = context.index.get(text);
  if (existing !== undefined) {
    return existing;
  }
  const assigned = context.dictionary.length;
  context.dictionary.push(text);
  context.index.set(text, assigned);
  return assigned;
}

function writeValue(context: EncodeContext, value: unknown, depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new MiddleOutFormatError(`json nesting deeper than ${MAX_DEPTH}`);
  }
  if (value === null) {
    context.tokens.pushByte(TAG_NULL);
    return;
  }
  if (typeof value === 'boolean') {
    context.tokens.pushByte(value ? TAG_TRUE : TAG_FALSE);
    return;
  }
  if (typeof value === 'number') {
    writeNumber(context, value);
    return;
  }
  if (typeof value === 'string') {
    writeString(context, value);
    return;
  }
  if (isJsonArray(value)) {
    context.tokens.pushByte(TAG_ARRAY);
    context.tokens.pushVarint(value.length);
    for (const element of value) {
      writeValue(context, element, depth + 1);
    }
    return;
  }
  if (isJsonRecord(value)) {
    const entries = Object.entries(value);
    context.tokens.pushByte(TAG_OBJECT);
    context.tokens.pushVarint(entries.length);
    for (const [key, element] of entries) {
      writeString(context, key);
      writeValue(context, element, depth + 1);
    }
    return;
  }
  throw new MiddleOutFormatError(`unsupported json value of type ${typeof value}`);
}

function writeNumber(context: EncodeContext, value: number): void {
  if (Number.isSafeInteger(value)) {
    if (value >= 0) {
      context.tokens.pushByte(TAG_UINT);
      // Normalizes -0, whose canonical JSON text is "0".
      context.tokens.pushVarint(value === 0 ? 0 : value);
      return;
    }
    context.tokens.pushByte(TAG_NEGINT);
    context.tokens.pushVarint(-value);
    return;
  }
  // Fractions, exponentials and out-of-safe-range magnitudes keep their exact
  // canonical text; `Number(text)` restores the identical double.
  context.tokens.pushByte(TAG_NUMBER_TEXT);
  context.tokens.pushString(String(value));
}

function writeString(context: EncodeContext, text: string): void {
  const token = recognizeString(text, (prefix) => internString(context, prefix));
  writeStringToken(
    context.tokens,
    token ?? { tag: TAG_STRING_REF, index: internString(context, text) },
  );
}

function isJsonArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/* -------------------------------------------------------------------------- */
/* Outward: token stream -> JSON tree                                         */
/* -------------------------------------------------------------------------- */

function readValue(reader: ByteReader, dictionary: readonly string[], depth: number): JsonValue {
  if (depth > MAX_DEPTH) {
    throw new MiddleOutFormatError(`container nesting deeper than ${MAX_DEPTH}`);
  }
  const tag = reader.readByte();
  const stringToken = readStringToken(tag, reader);
  if (stringToken !== null) {
    return renderStringToken(stringToken, dictionary);
  }
  switch (tag) {
    case TAG_NULL:
      return null;
    case TAG_TRUE:
      return true;
    case TAG_FALSE:
      return false;
    case TAG_UINT:
      return reader.readVarint();
    case TAG_NEGINT: {
      const magnitude = reader.readVarint();
      if (magnitude === 0) {
        throw new MiddleOutFormatError('negative zero is not a canonical token');
      }
      return -magnitude;
    }
    case TAG_NUMBER_TEXT:
      return Number(reader.readString());
    case TAG_ARRAY: {
      const length = reader.readVarint();
      const elements: JsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        elements.push(readValue(reader, dictionary, depth + 1));
      }
      return elements;
    }
    case TAG_OBJECT: {
      const size = reader.readVarint();
      const entries: [string, JsonValue][] = [];
      for (let index = 0; index < size; index += 1) {
        const key = readKey(reader, dictionary);
        entries.push([key, readValue(reader, dictionary, depth + 1)]);
      }
      // `Object.fromEntries` defines own properties, so a "__proto__" key
      // behaves exactly as it does under `JSON.parse` instead of hitting the
      // prototype setter.
      return Object.fromEntries(entries);
    }
    default:
      throw new MiddleOutFormatError(`unknown token tag 0x${tag.toString(16).padStart(2, '0')}`);
  }
}

function readKey(reader: ByteReader, dictionary: readonly string[]): string {
  const tag = reader.readByte();
  const token = readStringToken(tag, reader);
  if (token === null) {
    throw new MiddleOutFormatError(
      `object key carries non-string tag 0x${tag.toString(16).padStart(2, '0')}`,
    );
  }
  return renderStringToken(token, dictionary);
}

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
