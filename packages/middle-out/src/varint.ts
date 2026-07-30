/**
 * Byte-level primitives for the middle-out token stream: unsigned LEB128 varints
 * plus the minimal growable writer / cursor reader pair everything else is built on.
 *
 * Values are carried as JavaScript numbers, so the representable range is
 * `[0, Number.MAX_SAFE_INTEGER]`. All arithmetic here avoids bitwise operators on
 * values wider than 32 bits (`&`/`>>>` coerce to int32 and would silently corrupt
 * anything above 2^31), using `%` and `Math.floor` on exact integers instead.
 */

/** Largest integer a varint may carry; above this, doubles stop being exact integers. */
export const VARINT_MAX = Number.MAX_SAFE_INTEGER;

/** `VARINT_MAX` occupies 53 bits, i.e. eight 7-bit groups. */
export const VARINT_MAX_BYTES = 8;

const TEXT_ENCODER = new TextEncoder();

/** `fatal` makes malformed UTF-8 throw instead of silently becoming U+FFFD. */
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

/** Raised when a byte stream ends early or holds a value the reader cannot represent. */
export class ByteCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ByteCodecError';
  }
}

/** Raised on varint truncation, overflow past `VARINT_MAX`, or a non-minimal encoding. */
export class VarintError extends ByteCodecError {
  constructor(message: string) {
    super(message);
    this.name = 'VarintError';
  }
}

function assertVarintEncodable(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new VarintError(
      `varint values must be integers in [0, ${VARINT_MAX}]; received ${value}`,
    );
  }
}

/** Number of bytes `value` occupies when written as a varint. */
export function varintByteLength(value: number): number {
  assertVarintEncodable(value);
  let length = 1;
  let rest = Math.floor(value / 128);
  while (rest > 0) {
    length += 1;
    rest = Math.floor(rest / 128);
  }
  return length;
}

/**
 * Reads one varint starting at `offset`.
 *
 * Rejects non-minimal encodings (a trailing group of zero bits), so every
 * in-range integer has exactly one valid byte representation.
 */
export function readVarint(
  bytes: Uint8Array,
  offset: number,
): { readonly value: number; readonly next: number } {
  let value = 0;
  let scale = 1;
  let cursor = offset;
  for (let group = 0; group < VARINT_MAX_BYTES; group += 1) {
    const byte = bytes[cursor];
    if (byte === undefined) {
      throw new VarintError(`truncated varint starting at offset ${offset}`);
    }
    cursor += 1;
    const payload = byte % 128;
    // `scale` is always a power of two, so this division is exact in IEEE-754
    // doubles: the bound below is a real limit, not an approximation of one.
    if (payload > Math.floor((VARINT_MAX - value) / scale)) {
      throw new VarintError(`varint at offset ${offset} exceeds ${VARINT_MAX}`);
    }
    value += payload * scale;
    if (byte < 0x80) {
      if (group > 0 && payload === 0) {
        throw new VarintError(`non-minimal varint encoding at offset ${offset}`);
      }
      return { value, next: cursor };
    }
    scale *= 128;
  }
  throw new VarintError(`varint at offset ${offset} is longer than ${VARINT_MAX_BYTES} bytes`);
}

/** Append-only byte buffer that doubles its capacity as needed. */
export class ByteWriter {
  #buffer: Uint8Array;
  #length = 0;

  constructor(initialCapacity = 512) {
    this.#buffer = new Uint8Array(Math.max(16, Math.ceil(initialCapacity)));
  }

  /** Number of bytes written so far. */
  get length(): number {
    return this.#length;
  }

  #reserve(extra: number): void {
    const needed = this.#length + extra;
    if (needed <= this.#buffer.length) {
      return;
    }
    let capacity = this.#buffer.length * 2;
    while (capacity < needed) {
      capacity *= 2;
    }
    const grown = new Uint8Array(capacity);
    grown.set(this.#buffer.subarray(0, this.#length));
    this.#buffer = grown;
  }

  pushByte(byte: number): void {
    this.#reserve(1);
    this.#buffer[this.#length] = byte;
    this.#length += 1;
  }

  pushBytes(source: Uint8Array): void {
    this.#reserve(source.length);
    this.#buffer.set(source, this.#length);
    this.#length += source.length;
  }

  pushVarint(value: number): void {
    assertVarintEncodable(value);
    this.#reserve(VARINT_MAX_BYTES);
    let rest = value;
    while (rest >= 0x80) {
      this.#buffer[this.#length] = (rest % 128) + 0x80;
      this.#length += 1;
      rest = Math.floor(rest / 128);
    }
    this.#buffer[this.#length] = rest;
    this.#length += 1;
  }

  /**
   * UTF-8 bytes prefixed with their varint byte length.
   *
   * Refuses a string holding an unpaired surrogate. `TextEncoder` substitutes U+FFFD for one,
   * which is a silent and irreversible edit, and `JSON.parse('"\\ud800"')` produces exactly such
   * a string — so this is a reachable input, not a theoretical one. Throwing here makes the
   * container-level fallback explicit and immediate instead of leaving a corrupted payload for
   * the encoder's self-verify step to notice after it has already paid for compression.
   */
  pushString(text: string): void {
    if (!isWellFormedUtf16(text)) {
      throw new ByteCodecError('cannot encode a string holding an unpaired surrogate as UTF-8');
    }
    const encoded = TEXT_ENCODER.encode(text);
    this.pushVarint(encoded.length);
    this.pushBytes(encoded);
  }

  /** Copy of the written region. */
  toUint8Array(): Uint8Array {
    return this.#buffer.slice(0, this.#length);
  }
}

/** Cursor over a byte buffer, mirroring {@link ByteWriter}. */
export class ByteReader {
  readonly #bytes: Uint8Array;
  #offset: number;

  constructor(bytes: Uint8Array, offset = 0) {
    this.#bytes = bytes;
    this.#offset = offset;
  }

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.#bytes.length - this.#offset;
  }

  readByte(): number {
    const byte = this.#bytes[this.#offset];
    if (byte === undefined) {
      throw new ByteCodecError(`unexpected end of input at offset ${this.#offset}`);
    }
    this.#offset += 1;
    return byte;
  }

  /** Borrows `count` bytes as a view over the backing buffer; does not copy. */
  readBytes(count: number): Uint8Array {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.remaining) {
      throw new ByteCodecError(
        `cannot read ${count} bytes at offset ${this.#offset}; ${this.remaining} remaining`,
      );
    }
    const view = this.#bytes.subarray(this.#offset, this.#offset + count);
    this.#offset += count;
    return view;
  }

  readVarint(): number {
    const { value, next } = readVarint(this.#bytes, this.#offset);
    this.#offset = next;
    return value;
  }

  readString(): string {
    const byteLength = this.readVarint();
    return TEXT_DECODER.decode(this.readBytes(byteLength));
  }
}

/**
 * True when `text` contains no unpaired surrogate, i.e. when UTF-8 can carry it losslessly.
 *
 * A JavaScript string is a sequence of UTF-16 code units, not of Unicode scalar values, so it can
 * hold a surrogate with no partner. UTF-8 cannot represent one: `TextEncoder` replaces it with
 * U+FFFD. Every byte-level string carrier in this package therefore has to check first — the
 * alternative is a substitution that no length check and no decode can detect afterwards.
 */
export function isWellFormedUtf16(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdfff) {
      continue;
    }
    if (unit > 0xdbff) {
      // A trailing surrogate reached before any leading surrogate.
      return false;
    }
    // `charCodeAt` past the end is NaN, which fails both comparisons below.
    const next = text.charCodeAt(index + 1);
    if (!(next >= 0xdc00 && next <= 0xdfff)) {
      return false;
    }
    index += 1;
  }
  return true;
}

/** UTF-8 encode, sharing the module-level encoder. */
export function encodeUtf8(text: string): Uint8Array {
  return TEXT_ENCODER.encode(text);
}

/** Strict UTF-8 decode; throws on invalid sequences. */
export function decodeUtf8(bytes: Uint8Array): string {
  return TEXT_DECODER.decode(bytes);
}
