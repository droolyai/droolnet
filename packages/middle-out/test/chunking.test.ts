import { describe, expect, test } from 'vitest';
import {
  chunkBytes,
  ChunkingError,
  DEFAULT_CHUNKING_OPTIONS,
  resolveChunkingOptions,
  type Chunk,
  type ChunkingOptions,
} from '../src/chunking.js';

/**
 * splitmix32, inlined so every byte of test data is reproducible from this file alone.
 * `Math.random` would make a failure impossible to re-run.
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

function pseudoRandomBytes(length: number, seed: number): Uint8Array {
  const next = splitmix32(seed);
  const out = new Uint8Array(length);
  let i = 0;
  while (i < length) {
    const word = next();
    out[i] = word & 0xff;
    if (i + 1 < length) out[i + 1] = (word >>> 8) & 0xff;
    if (i + 2 < length) out[i + 2] = (word >>> 16) & 0xff;
    if (i + 3 < length) out[i + 3] = (word >>> 24) & 0xff;
    i += 4;
  }
  return out;
}

const DEFAULTS = DEFAULT_CHUNKING_OPTIONS;

/**
 * The coverage contract, checked structurally rather than by spot-checking lengths:
 * contiguous, ordered, non-empty, size-bounded, and covering exactly `total` bytes.
 */
function expectExactCover(
  total: number,
  chunks: readonly Chunk[],
  options?: ChunkingOptions,
): void {
  const { minSize, maxSize } = resolveChunkingOptions(options);

  if (total === 0) {
    expect(chunks).toEqual([]);
    return;
  }
  expect(chunks.length).toBeGreaterThan(0);

  let cursor = 0;
  for (const [index, chunk] of chunks.entries()) {
    expect(chunk.offset).toBe(cursor);
    expect(chunk.length).toBeGreaterThan(0);
    expect(chunk.length).toBeLessThanOrEqual(maxSize);
    const isLast = index === chunks.length - 1;
    if (!isLast) {
      // Only the final chunk may be shorter than minSize: it has no more input to grow into.
      expect(chunk.length).toBeGreaterThanOrEqual(minSize);
    }
    cursor += chunk.length;
  }
  expect(cursor).toBe(total);
}

/** Cumulative end offsets — the boundary positions, which is what resync is about. */
function cutPoints(chunks: readonly Chunk[]): number[] {
  const cuts: number[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    cursor += chunk.length;
    cuts.push(cursor);
  }
  return cuts;
}

function spliceInsert(source: Uint8Array, at: number, inserted: Uint8Array): Uint8Array {
  const out = new Uint8Array(source.length + inserted.length);
  out.set(source.subarray(0, at), 0);
  out.set(inserted, at);
  out.set(source.subarray(at), at + inserted.length);
  return out;
}

describe('chunkBytes coverage invariants', () => {
  const edgeSizes = [
    0,
    1,
    2,
    31,
    32,
    33,
    DEFAULTS.minSize - 1,
    DEFAULTS.minSize,
    DEFAULTS.minSize + 1,
    DEFAULTS.avgSize - 1,
    DEFAULTS.avgSize,
    DEFAULTS.avgSize + 1,
    DEFAULTS.maxSize - 1,
    DEFAULTS.maxSize,
    DEFAULTS.maxSize + 1,
    2 * DEFAULTS.maxSize,
    3 * DEFAULTS.maxSize + 7,
    100_003,
    1 << 20,
  ];

  test.each(edgeSizes)('covers exactly %i bytes with no gap or overlap', (size) => {
    const bytes = pseudoRandomBytes(size, 0x1000 + size);
    expectExactCover(size, chunkBytes(bytes));
  });

  test('empty input produces no chunks', () => {
    expect(chunkBytes(new Uint8Array(0))).toEqual([]);
  });

  test('a single byte produces one one-byte chunk', () => {
    expect(chunkBytes(new Uint8Array([0x2a]))).toEqual([{ offset: 0, length: 1 }]);
  });

  test('input of exactly minSize is one chunk', () => {
    const bytes = pseudoRandomBytes(DEFAULTS.minSize, 0x2001);
    expect(chunkBytes(bytes)).toEqual([{ offset: 0, length: DEFAULTS.minSize }]);
  });

  test('covers exactly across 40 assorted pseudo-random sizes', () => {
    const next = splitmix32(0xfeed);
    for (let trial = 0; trial < 40; trial += 1) {
      const size = next() % (2 * DEFAULTS.maxSize + 1);
      const bytes = pseudoRandomBytes(size, 0x3000 + trial);
      expectExactCover(size, chunkBytes(bytes));
    }
  });

  test('reassembling the chunk ranges rebuilds the input byte for byte', () => {
    const bytes = pseudoRandomBytes(1 << 20, 0x4001);
    const chunks = chunkBytes(bytes);
    const rebuilt = new Uint8Array(bytes.length);
    for (const chunk of chunks) {
      rebuilt.set(bytes.subarray(chunk.offset, chunk.offset + chunk.length), chunk.offset);
    }
    // Compared by first-differing-offset rather than `toEqual`: deep-equality on a
    // megabyte-scale typed array is orders of magnitude slower and its diff is unreadable.
    let mismatch = -1;
    for (let i = 0; i < bytes.length; i += 1) {
      if (rebuilt[i] !== bytes[i]) {
        mismatch = i;
        break;
      }
    }
    expect(mismatch).toBe(-1);
  });
});

describe('chunkBytes determinism', () => {
  test('the same input chunks identically twice', () => {
    const bytes = pseudoRandomBytes(1 << 20, 0x5001);
    expect(chunkBytes(bytes)).toEqual(chunkBytes(bytes));
  });

  test('a byte-identical copy in a different buffer chunks identically', () => {
    const bytes = pseudoRandomBytes(1 << 20, 0x5002);
    const copy = Uint8Array.from(bytes);
    expect(copy).not.toBe(bytes);
    expect(chunkBytes(copy)).toEqual(chunkBytes(bytes));
  });

  test('a subarray view chunks identically to a standalone buffer', () => {
    // Guards against reading the gear window relative to the buffer rather than the
    // chunk, which would make boundaries depend on where the bytes happen to live.
    const bytes = pseudoRandomBytes(300_000, 0x5003);
    const padded = new Uint8Array(bytes.length + 4096);
    padded.set(bytes, 4096);
    expect(chunkBytes(padded.subarray(4096))).toEqual(chunkBytes(bytes));
  });

  test('boundaries do not depend on the options object identity', () => {
    const bytes = pseudoRandomBytes(400_000, 0x5004);
    expect(chunkBytes(bytes, { ...DEFAULTS })).toEqual(chunkBytes(bytes));
  });
});

describe('chunkBytes size distribution', () => {
  test('mean chunk length on 8 MiB of pseudo-random data sits near avgSize', () => {
    const bytes = pseudoRandomBytes(8 << 20, 0xc0ffee);
    const chunks = chunkBytes(bytes);
    expectExactCover(bytes.length, chunks);

    const mean = bytes.length / chunks.length;
    // Normalized chunking is supposed to concentrate lengths around avgSize rather than
    // pile them onto the min/max clamps; a mean stuck near either clamp means the masks
    // are wrong even though coverage would still pass.
    expect(mean).toBeGreaterThan(DEFAULTS.avgSize * 0.6);
    expect(mean).toBeLessThan(DEFAULTS.avgSize * 2);

    const lengths = chunks.map((chunk) => chunk.length);
    const atCap = lengths.filter((length) => length === DEFAULTS.maxSize).length;
    expect(atCap / chunks.length).toBeLessThan(0.05);
  }, 30_000);

  test('custom small sizes are honoured', () => {
    const options = { minSize: 64, avgSize: 256, maxSize: 1024 } satisfies ChunkingOptions;
    const bytes = pseudoRandomBytes(1 << 20, 0x5eed);
    const chunks = chunkBytes(bytes, options);
    expectExactCover(bytes.length, chunks, options);

    const mean = bytes.length / chunks.length;
    expect(mean).toBeGreaterThan(options.avgSize * 0.5);
    expect(mean).toBeLessThan(options.avgSize * 2);
  });

  test('a long constant run is cut at maxSize, deterministically', () => {
    // A Gear fingerprint over a constant run converges to a fixed value, so the run either
    // always matches the mask or never does. For this fixed table it never does, which
    // leaves the hard cap as the only cut rule. Recorded here as a regression on the table.
    const zeros = new Uint8Array(8 * DEFAULTS.maxSize);
    const chunks = chunkBytes(zeros);
    expectExactCover(zeros.length, chunks);
    expect(chunks).toHaveLength(8);
    expect(chunks.every((chunk) => chunk.length === DEFAULTS.maxSize)).toBe(true);
  });
});

describe('chunkBytes boundary resynchronization', () => {
  test('boundaries past a front insertion realign to the original positions', () => {
    // The digest-level version of this measurement, plus the fixed-size-block contrast,
    // lives in dedup.test.ts. Here the claim is purely about boundary positions.
    const original = pseudoRandomBytes(8 << 20, 0xc0ffee);
    const insertion = pseudoRandomBytes(7, 0x0abc);
    const at = 1024;
    const edited = spliceInsert(original, at, insertion);

    const cutsOriginal = new Set(cutPoints(chunkBytes(original)));
    const cutsEdited = cutPoints(chunkBytes(edited));

    const past = cutsEdited.filter((cut) => cut >= at + insertion.length);
    const realigned = past.filter((cut) => cutsOriginal.has(cut - insertion.length));

    expect(past.length).toBeGreaterThan(100);
    expect(realigned.length / past.length).toBeGreaterThan(0.98);
  }, 30_000);

  test('boundaries past a deletion realign to the original positions', () => {
    const original = pseudoRandomBytes(8 << 20, 0xc0ffee);
    const at = 1024;
    const removed = 1500;
    const edited = new Uint8Array(original.length - removed);
    edited.set(original.subarray(0, at), 0);
    edited.set(original.subarray(at + removed), at);

    const cutsOriginal = new Set(cutPoints(chunkBytes(original)));
    const cutsEdited = cutPoints(chunkBytes(edited));

    const past = cutsEdited.filter((cut) => cut >= at);
    const realigned = past.filter((cut) => cutsOriginal.has(cut + removed));

    expect(past.length).toBeGreaterThan(100);
    expect(realigned.length / past.length).toBeGreaterThan(0.98);
  }, 30_000);
});

describe('resolveChunkingOptions validation', () => {
  test('defaults resolve to the documented sizes', () => {
    const resolved = resolveChunkingOptions();
    expect(resolved.minSize).toBe(8192);
    expect(resolved.avgSize).toBe(32768);
    expect(resolved.maxSize).toBe(131072);
  });

  test('the strict mask has more set bits than the lax mask', () => {
    const { maskStrict, maskLax } = resolveChunkingOptions();
    const popcount = (value: number): number => {
      let bits = 0;
      for (let v = value >>> 0; v !== 0; v >>>= 1) bits += v & 1;
      return bits;
    };
    expect(popcount(maskStrict)).toBe(17);
    expect(popcount(maskLax)).toBe(13);
    // Only high bits are tested; the weakly mixed low bits must be masked out entirely.
    expect(maskLax & 0xff).toBe(0);
  });

  const invalid: [label: string, options: ChunkingOptions][] = [
    ['minSize zero', { minSize: 0 }],
    ['minSize negative', { minSize: -8192 }],
    ['minSize fractional', { minSize: 8192.5 }],
    ['minSize NaN', { minSize: Number.NaN }],
    ['minSize Infinity', { minSize: Number.POSITIVE_INFINITY }],
    ['avgSize zero', { avgSize: 0 }],
    ['avgSize fractional', { avgSize: 32768.25 }],
    ['maxSize zero', { maxSize: 0 }],
    ['maxSize negative', { maxSize: -1 }],
    ['minSize equal to avgSize', { minSize: 32768, avgSize: 32768 }],
    ['minSize above avgSize', { minSize: 65536 }],
    ['avgSize equal to maxSize', { avgSize: 131072 }],
    ['avgSize above maxSize', { avgSize: 262144 }],
    ['avgSize below the supported range', { minSize: 1, avgSize: 4, maxSize: 16 }],
    ['avgSize above the supported range', { avgSize: 2 ** 31, maxSize: 2 ** 32 }],
  ];

  test.each(invalid)('rejects %s', (_label, options) => {
    expect(() => resolveChunkingOptions(options)).toThrow(ChunkingError);
    expect(() => chunkBytes(new Uint8Array(1024), options)).toThrow(ChunkingError);
  });

  test('ChunkingError is a named Error subclass', () => {
    const error = new ChunkingError('nope');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ChunkingError');
    expect(error.message).toBe('nope');
  });

  test('DEFAULT_CHUNKING_OPTIONS is frozen', () => {
    expect(Object.isFrozen(DEFAULT_CHUNKING_OPTIONS)).toBe(true);
  });
});
