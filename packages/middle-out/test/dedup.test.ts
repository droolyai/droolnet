import { describe, expect, test } from 'vitest';
import { chunkBytes, ChunkingError, type Chunk } from '../src/chunking.js';
import {
  ContentAddressedStore,
  DedupError,
  digestChunk,
  digestChunkSync,
  measureDedup,
} from '../src/dedup.js';

/** splitmix32, inlined so every byte of test data is reproducible from this file alone. */
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

/**
 * Index of the first differing byte, or -1 when the two are identical.
 *
 * `expect(a).toEqual(b)` on multi-megabyte typed arrays walks them through the generic
 * deep-equality path and takes tens of seconds; this is the same assertion in milliseconds,
 * and it reports the offset that differs instead of dumping 8 MiB of diff.
 */
function firstDifference(actual: Uint8Array, expected: Uint8Array): number {
  const shared = Math.min(actual.length, expected.length);
  for (let i = 0; i < shared; i += 1) {
    if (actual[i] !== expected[i]) {
      return i;
    }
  }
  return actual.length === expected.length ? -1 : shared;
}

function expectSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  expect(firstDifference(actual, expected)).toBe(-1);
}

function spliceInsert(source: Uint8Array, at: number, inserted: Uint8Array): Uint8Array {
  const out = new Uint8Array(source.length + inserted.length);
  out.set(source.subarray(0, at), 0);
  out.set(inserted, at);
  out.set(source.subarray(at), at + inserted.length);
  return out;
}

function digestsOf(bytes: Uint8Array, chunks: readonly Chunk[]): string[] {
  return chunks.map((chunk) =>
    digestChunkSync(bytes.subarray(chunk.offset, chunk.offset + chunk.length)),
  );
}

/**
 * The straw man, implemented here rather than shipped: fixed-size blocking. It is the
 * baseline the whole layer has to beat, so the contrast has to be measured, not asserted.
 */
function fixedSizeChunks(total: number, blockSize: number): Chunk[] {
  const chunks: Chunk[] = [];
  for (let offset = 0; offset < total; offset += blockSize) {
    chunks.push({ offset, length: Math.min(blockSize, total - offset) });
  }
  return chunks;
}

/** Fraction of `edited`'s chunks whose digest the store already holds from `original`. */
function overlapFraction(
  original: Uint8Array,
  originalChunks: readonly Chunk[],
  edited: Uint8Array,
  editedChunks: readonly Chunk[],
): { chunkFraction: number; byteFraction: number; missChunks: number } {
  const known = new Set(digestsOf(original, originalChunks));
  const editedDigests = digestsOf(edited, editedChunks);

  let hitChunks = 0;
  let hitBytes = 0;
  for (const [index, digest] of editedDigests.entries()) {
    if (known.has(digest)) {
      hitChunks += 1;
      hitBytes += editedChunks[index]?.length ?? 0;
    }
  }
  return {
    chunkFraction: hitChunks / editedChunks.length,
    byteFraction: hitBytes / edited.length,
    missChunks: editedChunks.length - hitChunks,
  };
}

describe('digestChunk', () => {
  test('matches the published SHA-256 of the empty input', async () => {
    const expected = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(digestChunkSync(new Uint8Array(0))).toBe(expected);
    await expect(digestChunk(new Uint8Array(0))).resolves.toBe(expected);
  });

  test('matches the published SHA-256 of "abc"', async () => {
    const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const abc = new Uint8Array([0x61, 0x62, 0x63]);
    expect(digestChunkSync(abc)).toBe(expected);
    await expect(digestChunk(abc)).resolves.toBe(expected);
  });

  test('is lowercase hex of exactly 64 characters', () => {
    const digest = digestChunkSync(pseudoRandomBytes(1000, 0x11));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('depends on content, not on the backing buffer', () => {
    const bytes = pseudoRandomBytes(5000, 0x12);
    const padded = new Uint8Array(bytes.length + 64);
    padded.set(bytes, 32);
    expect(digestChunkSync(padded.subarray(32, 32 + bytes.length))).toBe(digestChunkSync(bytes));
  });
});

describe('ContentAddressedStore round trip', () => {
  const sizes = [0, 1, 2, 8191, 8192, 8193, 32768, 131072, 131073, 100_003, 1 << 20];

  test.each(sizes)('get(put(x)) returns x byte for byte at %i bytes', (size) => {
    const store = new ContentAddressedStore();
    const bytes = pseudoRandomBytes(size, 0x6000 + size);
    const manifest = store.put(bytes);

    expect(manifest.totalBytes).toBe(size);
    expect(manifest.digests).toHaveLength(chunkBytes(bytes).length);
    expectSameBytes(store.get(manifest), bytes);
  });

  test('round trips 30 assorted pseudo-random inputs through one store', () => {
    const store = new ContentAddressedStore();
    const next = splitmix32(0xbeef);
    for (let trial = 0; trial < 30; trial += 1) {
      const size = next() % 300_000;
      const bytes = pseudoRandomBytes(size, 0x7000 + trial);
      expectSameBytes(store.get(store.put(bytes)), bytes);
    }
  });

  test('round trips with custom small chunk sizes', () => {
    const store = new ContentAddressedStore({ minSize: 64, avgSize: 256, maxSize: 1024 });
    const bytes = pseudoRandomBytes(200_000, 0x8001);
    const manifest = store.put(bytes);
    expect(manifest.digests.length).toBeGreaterThan(100);
    expectSameBytes(store.get(manifest), bytes);
  });

  test('stored chunks are owned by the store, not aliased to the caller buffer', () => {
    const store = new ContentAddressedStore();
    const bytes = pseudoRandomBytes(200_000, 0x8002);
    const manifest = store.put(bytes);
    const snapshot = Uint8Array.from(bytes);

    bytes.fill(0);
    expectSameBytes(store.get(manifest), snapshot);
  });

  test('a manifest resolves against any store holding the same content', () => {
    const bytes = pseudoRandomBytes(500_000, 0x8003);
    const writer = new ContentAddressedStore();
    const mirror = new ContentAddressedStore();
    const manifest = writer.put(bytes);
    mirror.put(bytes);
    expectSameBytes(mirror.get(manifest), bytes);
  });

  test('stores are independent', () => {
    const bytes = pseudoRandomBytes(100_000, 0x8004);
    const a = new ContentAddressedStore();
    const b = new ContentAddressedStore();
    const manifest = a.put(bytes);
    expect(() => b.get(manifest)).toThrow(DedupError);
  });

  test('a manifest naming an absent chunk throws instead of returning short bytes', () => {
    const store = new ContentAddressedStore();
    const manifest = store.put(pseudoRandomBytes(100_000, 0x8005));
    const corrupted = {
      digests: [...manifest.digests, 'f'.repeat(64)],
      totalBytes: manifest.totalBytes,
    };
    expect(() => store.get(corrupted)).toThrow(DedupError);
  });

  test('a manifest whose totalBytes disagrees with its chunks throws', () => {
    const store = new ContentAddressedStore();
    const manifest = store.put(pseudoRandomBytes(100_000, 0x8006));
    expect(() => store.get({ digests: manifest.digests, totalBytes: 999_999 })).toThrow(DedupError);
    expect(() => store.get({ digests: manifest.digests, totalBytes: 10 })).toThrow(DedupError);
  });

  test('invalid options throw from the constructor', () => {
    expect(() => new ContentAddressedStore({ minSize: 0 })).toThrow(ChunkingError);
    expect(() => new ContentAddressedStore({ avgSize: 4096 })).toThrow(ChunkingError);
    expect(() => measureDedup([], { maxSize: -1 })).toThrow(ChunkingError);
  });

  test('DedupError is a named Error subclass', () => {
    const error = new DedupError('nope');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DedupError');
  });
});

describe('dedup accounting', () => {
  test('an empty store reports a ratio of 1', () => {
    const stats = new ContentAddressedStore().stats();
    expect(stats).toEqual({
      totalBytes: 0,
      storedBytes: 0,
      totalChunks: 0,
      uniqueChunks: 0,
      dedupRatio: 1,
    });
  });

  test('identical content added twice stores nothing new and doubles the ratio', () => {
    const bytes = pseudoRandomBytes(4 << 20, 0x9001);
    const store = new ContentAddressedStore();

    store.put(bytes);
    const first = store.stats();
    expect(first.storedBytes).toBe(bytes.length);
    expect(first.uniqueChunks).toBe(first.totalChunks);
    expect(first.dedupRatio).toBe(1);

    store.put(Uint8Array.from(bytes));
    const second = store.stats();
    expect(second.storedBytes).toBe(first.storedBytes);
    expect(second.uniqueChunks).toBe(first.uniqueChunks);
    expect(second.totalBytes).toBe(2 * bytes.length);
    expect(second.totalChunks).toBe(2 * first.totalChunks);
    expect(second.dedupRatio).toBe(2);
  }, 30_000);

  test('measureDedup aggregates over sources', () => {
    const bytes = pseudoRandomBytes(2 << 20, 0x9002);
    const copies = [bytes, Uint8Array.from(bytes), Uint8Array.from(bytes), Uint8Array.from(bytes)];
    const stats = measureDedup(copies);

    expect(stats.totalBytes).toBe(4 * bytes.length);
    expect(stats.storedBytes).toBe(bytes.length);
    expect(stats.dedupRatio).toBeCloseTo(4, 10);
  }, 30_000);

  test('unrelated sources do not dedup, so the ratio stays at 1', () => {
    const sources = [
      pseudoRandomBytes(1 << 20, 0xa001),
      pseudoRandomBytes(1 << 20, 0xa002),
      pseudoRandomBytes(1 << 20, 0xa003),
    ];
    const stats = measureDedup(sources);
    expect(stats.totalBytes).toBe(3 << 20);
    expect(stats.storedBytes).toBe(stats.totalBytes);
    expect(stats.dedupRatio).toBe(1);
    expect(stats.uniqueChunks).toBe(stats.totalChunks);
  }, 30_000);

  test('measureDedup over no sources reports the empty result', () => {
    expect(measureDedup([]).dedupRatio).toBe(1);
    expect(measureDedup([]).totalBytes).toBe(0);
  });
});

describe('insertion resilience — the load-bearing property of layer 1', () => {
  const BLOCK_SIZE = 32768;

  test('a 7-byte insertion near the front leaves nearly every chunk deduplicable', () => {
    const original = pseudoRandomBytes(8 << 20, 0xc0ffee);
    const insertion = pseudoRandomBytes(7, 0x0abc);
    const at = 1024;
    const edited = spliceInsert(original, at, insertion);
    expect(edited.length).toBe(original.length + insertion.length);

    const cdc = overlapFraction(original, chunkBytes(original), edited, chunkBytes(edited));
    const fixed = overlapFraction(
      original,
      fixedSizeChunks(original.length, BLOCK_SIZE),
      edited,
      fixedSizeChunks(edited.length, BLOCK_SIZE),
    );

    // Printed because the point of this test is the measurement, not just the threshold.
    console.log(
      `[insertion resilience] 8 MiB, ${String(insertion.length)}-byte insert at offset ` +
        `${String(at)}: CDC ${(100 * cdc.chunkFraction).toFixed(3)}% of chunks / ` +
        `${(100 * cdc.byteFraction).toFixed(3)}% of bytes already stored ` +
        `(${String(cdc.missChunks)} new chunks); fixed ${String(BLOCK_SIZE)}-byte blocks ` +
        `${(100 * fixed.chunkFraction).toFixed(3)}% of blocks / ` +
        `${(100 * fixed.byteFraction).toFixed(3)}% of bytes.`,
    );

    // Content-defined boundaries must resynchronize: the edit should cost a handful of
    // chunks, not a proportion of the file.
    expect(cdc.chunkFraction).toBeGreaterThan(0.97);
    expect(cdc.byteFraction).toBeGreaterThan(0.97);
    expect(cdc.missChunks).toBeLessThanOrEqual(3);

    // Fixed-size blocking shifts every block after the edit, so essentially nothing hits.
    expect(fixed.chunkFraction).toBeLessThan(0.02);

    // The contrast is the claim. Stated as an absolute gap so it cannot be satisfied by
    // both numbers being high.
    expect(cdc.chunkFraction - fixed.chunkFraction).toBeGreaterThan(0.9);
    expect(cdc.byteFraction - fixed.byteFraction).toBeGreaterThan(0.9);
  }, 30_000);

  test('a single-byte insertion is enough to destroy fixed-size dedup', () => {
    const original = pseudoRandomBytes(8 << 20, 0xc0ffee);
    const edited = spliceInsert(original, 512, new Uint8Array([0x5a]));

    const cdc = overlapFraction(original, chunkBytes(original), edited, chunkBytes(edited));
    const fixed = overlapFraction(
      original,
      fixedSizeChunks(original.length, BLOCK_SIZE),
      edited,
      fixedSizeChunks(edited.length, BLOCK_SIZE),
    );

    console.log(
      `[insertion resilience] 8 MiB, 1-byte insert at offset 512: CDC ` +
        `${(100 * cdc.chunkFraction).toFixed(3)}% of chunks already stored ` +
        `(${String(cdc.missChunks)} new chunks); fixed blocks ` +
        `${(100 * fixed.chunkFraction).toFixed(3)}%.`,
    );

    expect(cdc.chunkFraction).toBeGreaterThan(0.97);
    expect(fixed.chunkFraction).toBeLessThan(0.02);
  }, 30_000);

  test('the store realizes the win: an edited re-upload costs only the changed chunks', () => {
    const original = pseudoRandomBytes(8 << 20, 0xc0ffee);
    const edited = spliceInsert(original, 1024, pseudoRandomBytes(7, 0x0abc));

    const store = new ContentAddressedStore();
    const originalManifest = store.put(original);
    const bytesAfterFirst = store.stats().storedBytes;
    const editedManifest = store.put(edited);
    const stats = store.stats();

    // Both versions still reassemble exactly. Dedup must never be a lossy shortcut.
    expectSameBytes(store.get(originalManifest), original);
    expectSameBytes(store.get(editedManifest), edited);

    const addedBytes = stats.storedBytes - bytesAfterFirst;
    console.log(
      `[insertion resilience] second upload of an edited 8 MiB file added ` +
        `${String(addedBytes)} stored bytes for ${String(edited.length)} uploaded bytes ` +
        `(dedupRatio ${stats.dedupRatio.toFixed(4)}).`,
    );

    expect(addedBytes).toBeLessThan(edited.length * 0.05);
    expect(stats.dedupRatio).toBeGreaterThan(1.9);
  }, 30_000);

  test('an insertion in the middle of a large file behaves the same way', () => {
    const original = pseudoRandomBytes(8 << 20, 0xc0ffee);
    const edited = spliceInsert(original, 4 << 20, pseudoRandomBytes(4096, 0x0dad));

    const cdc = overlapFraction(original, chunkBytes(original), edited, chunkBytes(edited));
    expect(cdc.chunkFraction).toBeGreaterThan(0.97);
    expect(cdc.missChunks).toBeLessThanOrEqual(3);
  }, 30_000);

  test('a deletion near the front is equally survivable', () => {
    const original = pseudoRandomBytes(8 << 20, 0xc0ffee);
    const at = 1024;
    const removed = 1500;
    const edited = new Uint8Array(original.length - removed);
    edited.set(original.subarray(0, at), 0);
    edited.set(original.subarray(at + removed), at);

    const cdc = overlapFraction(original, chunkBytes(original), edited, chunkBytes(edited));
    const fixed = overlapFraction(
      original,
      fixedSizeChunks(original.length, BLOCK_SIZE),
      edited,
      fixedSizeChunks(edited.length, BLOCK_SIZE),
    );

    console.log(
      `[deletion resilience] 8 MiB, ${String(removed)} bytes removed at offset ` +
        `${String(at)}: CDC ${(100 * cdc.chunkFraction).toFixed(3)}% of chunks already ` +
        `stored (${String(cdc.missChunks)} new chunks); fixed blocks ` +
        `${(100 * fixed.chunkFraction).toFixed(3)}%.`,
    );

    expect(cdc.chunkFraction).toBeGreaterThan(0.97);
    expect(fixed.chunkFraction).toBeLessThan(0.02);
  }, 30_000);
});
