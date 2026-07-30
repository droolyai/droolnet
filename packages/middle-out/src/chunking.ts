/**
 * Layer 1 of middle-out: content-defined chunking (FastCDC, normalized).
 *
 * In a content-addressed network a chunk is stored once, globally — across every
 * rendition, re-upload, mirror and edit. Fixed-size blocking throws that away the
 * moment a byte is inserted: every following block shifts and re-hashes. A
 * content-defined boundary is a function of the bytes immediately around it, so the
 * boundary stream resynchronizes after an edit and dedup survives it.
 *
 * Arithmetic choice: the Gear fingerprint is a 32-bit unsigned integer held in a
 * `number` and normalized with `>>> 0`. The published FastCDC uses a 64-bit
 * fingerprint, but JavaScript has no fast 64-bit integer — `BigInt` allocates and is
 * roughly an order of magnitude slower per byte, and this loop runs once per input
 * byte. 32 bits is sufficient here: the mask never needs more than 32 set bits for the
 * chunk sizes this codec supports (see `MAX_SUPPORTED_AVG_SIZE`), and the rolling
 * window a 32-bit Gear hash sees is 32 bytes, which is in the same range as the
 * 48-byte windows classic Rabin chunkers use.
 */

/** A chunk of the input: the half-open byte range `[offset, offset + length)`. */
export interface Chunk {
  readonly offset: number;
  readonly length: number;
}

/** Chunk size targets. Every field is optional and falls back to the default. */
export interface ChunkingOptions {
  /** No boundary may be emitted before a chunk reaches this length. */
  readonly minSize?: number;
  /** Target mean chunk length; also the point where the mask relaxes. */
  readonly avgSize?: number;
  /** Hard cap: a chunk is cut here whether or not the content says so. */
  readonly maxSize?: number;
}

/** Fully specified sizes plus the derived judgement masks. */
export interface ResolvedChunkingOptions {
  readonly minSize: number;
  readonly avgSize: number;
  readonly maxSize: number;
  /** Applied while the chunk is shorter than `avgSize`; more set bits, so stricter. */
  readonly maskStrict: number;
  /** Applied once the chunk is at least `avgSize`; fewer set bits, so laxer. */
  readonly maskLax: number;
}

export const DEFAULT_CHUNKING_OPTIONS: Required<ChunkingOptions> = Object.freeze({
  minSize: 8 * 1024,
  avgSize: 32 * 1024,
  maxSize: 128 * 1024,
});

/** Thrown for invalid chunking options. Never thrown for any input byte sequence. */
export class ChunkingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChunkingError';
  }
}

/** Width of the Gear fingerprint, and therefore of its rolling window in bytes. */
const FINGERPRINT_BITS = 32;

/**
 * FastCDC normalized-chunking level. The strict mask gets `avgBits + LEVEL` set bits
 * and the lax mask `avgBits - LEVEL`, which pulls the chunk length distribution in
 * towards `avgSize` instead of the long exponential tail a single mask produces.
 */
const NORMALIZATION_LEVEL = 2;

/** `avgBits - NORMALIZATION_LEVEL >= 1` and `avgBits + NORMALIZATION_LEVEL <= 32`. */
const MIN_SUPPORTED_AVG_SIZE = 8;
const MAX_SUPPORTED_AVG_SIZE = 2 ** 30;

/**
 * Seed for the Gear table, fixed forever: chunk boundaries are part of this network's
 * wire format, so the table must be byte-identical on every machine and every run.
 * The value is ASCII 'WKNT'.
 */
const GEAR_SEED = 0x574b_4e54;

/**
 * splitmix32 — a small, well-mixed 32-bit PRNG. Written inline because the Gear table
 * must be reproducible from this source alone, with no dependency and no `Math.random`.
 */
function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e37_79b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0_aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a_2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
}

function buildGearTable(seed: number): Uint32Array {
  const next = splitmix32(seed);
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    table[i] = next();
  }
  return table;
}

const GEAR = buildGearTable(GEAR_SEED);

/**
 * One Gear step: `fp = (fp << 1) + GEAR[byte]`, truncated to 32 bits.
 *
 * Expanding the recurrence, `fp` after byte `m` is
 * `sum over j of GEAR[byte(m - j)] * 2^j  (mod 2^32)`, so every term with `j >= 32`
 * vanishes: the fingerprint is a pure function of the last 32 bytes. That is the
 * property the whole layer rests on.
 *
 * `GEAR` holds exactly 256 entries and `byte` always comes from a `Uint8Array`, so the
 * read is in range; the assertion restates the bound for `noUncheckedIndexedAccess`
 * rather than assuming anything.
 */
function gearStep(fp: number, byte: number): number {
  return (((fp << 1) >>> 0) + (GEAR[byte] as number)) >>> 0;
}

/**
 * A mask with the top `bits` bits of a 32-bit word set.
 *
 * Only high bits are tested. Bit `p` of a Gear fingerprint depends on the last `p + 1`
 * bytes, so the low bits are barely mixed — bit 0 is a single table entry's low bit. The
 * top 17 bits (the default strict mask) each depend on at least 16 bytes of content.
 */
function topBitsMask(bits: number): number {
  return (0xffff_ffff << (FINGERPRINT_BITS - bits)) >>> 0;
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ChunkingError(`${name} must be a positive integer, received ${String(value)}`);
  }
}

/** Validates sizes and derives the two masks. Throws `ChunkingError` on bad options. */
export function resolveChunkingOptions(options?: ChunkingOptions): ResolvedChunkingOptions {
  const minSize = options?.minSize ?? DEFAULT_CHUNKING_OPTIONS.minSize;
  const avgSize = options?.avgSize ?? DEFAULT_CHUNKING_OPTIONS.avgSize;
  const maxSize = options?.maxSize ?? DEFAULT_CHUNKING_OPTIONS.maxSize;

  requirePositiveInteger('minSize', minSize);
  requirePositiveInteger('avgSize', avgSize);
  requirePositiveInteger('maxSize', maxSize);

  if (minSize >= avgSize) {
    throw new ChunkingError(`minSize (${String(minSize)}) must be < avgSize (${String(avgSize)})`);
  }
  if (avgSize >= maxSize) {
    throw new ChunkingError(`avgSize (${String(avgSize)}) must be < maxSize (${String(maxSize)})`);
  }
  if (avgSize < MIN_SUPPORTED_AVG_SIZE || avgSize > MAX_SUPPORTED_AVG_SIZE) {
    throw new ChunkingError(
      `avgSize (${String(avgSize)}) must be between ${String(MIN_SUPPORTED_AVG_SIZE)} and ` +
        `${String(MAX_SUPPORTED_AVG_SIZE)}; outside that range the 32-bit fingerprint cannot ` +
        `carry a normalized mask`,
    );
  }

  const avgBits = Math.round(Math.log2(avgSize));
  return {
    minSize,
    avgSize,
    maxSize,
    maskStrict: topBitsMask(avgBits + NORMALIZATION_LEVEL),
    maskLax: topBitsMask(avgBits - NORMALIZATION_LEVEL),
  };
}

/**
 * Length of the chunk starting at `start`, in `[1, min(maxSize, end - start)]`.
 *
 * Deviation from the FastCDC reference pseudocode, deliberate: the reference starts the
 * fingerprint at zero at `start + minSize`, which makes the first 31 judged positions
 * depend on how far they are from the chunk start rather than purely on their own 32
 * preceding bytes. Here the hash is warmed over the 32 bytes before the first judged
 * position, so *every* judged position is a pure function of the 32 bytes ending there.
 * That is what makes resynchronization after an insertion a property of the content
 * alone, and it costs 32 extra Gear steps per chunk. Cut-point skipping is unchanged: no
 * position before `minSize` is ever judged.
 */
function nextChunkLength(
  bytes: Uint8Array,
  start: number,
  end: number,
  options: ResolvedChunkingOptions,
): number {
  const { minSize, avgSize, maxSize, maskStrict, maskLax } = options;
  const remaining = end - start;
  if (remaining <= minSize) {
    return remaining;
  }

  // Judging index `i` means cutting after that byte, i.e. a chunk of length `i + 1`.
  const hardLimit = Math.min(maxSize, remaining);
  const normalLimit = Math.min(avgSize, hardLimit);
  const firstJudged = minSize - 1;
  const warmFrom = Math.max(0, firstJudged - FINGERPRINT_BITS);

  let fp = 0;
  for (let i = warmFrom; i < firstJudged; i += 1) {
    fp = gearStep(fp, bytes[start + i] as number);
  }
  for (let i = firstJudged; i < normalLimit; i += 1) {
    fp = gearStep(fp, bytes[start + i] as number);
    if ((fp & maskStrict) === 0) {
      return i + 1;
    }
  }
  for (let i = normalLimit; i < hardLimit; i += 1) {
    fp = gearStep(fp, bytes[start + i] as number);
    if ((fp & maskLax) === 0) {
      return i + 1;
    }
  }
  return hardLimit;
}

/**
 * Splits `bytes` into content-defined chunks.
 *
 * Guarantees, all covered by `test/chunking.test.ts`:
 * - every chunk is non-empty;
 * - chunks are contiguous and ordered, and together cover exactly `bytes` with no gap
 *   and no overlap (`chunks[0].offset === 0`, and the last chunk ends at `bytes.length`);
 * - every chunk length is `<= maxSize`, and every chunk but the last is `>= minSize`;
 * - the result depends only on the bytes and the options, never on position in a larger
 *   buffer, wall clock, or platform.
 */
export function chunkBytes(bytes: Uint8Array, options?: ChunkingOptions): Chunk[] {
  const resolved = resolveChunkingOptions(options);
  const chunks: Chunk[] = [];
  const end = bytes.length;
  let offset = 0;
  while (offset < end) {
    const length = nextChunkLength(bytes, offset, end, resolved);
    chunks.push({ offset, length });
    offset += length;
  }
  return chunks;
}
