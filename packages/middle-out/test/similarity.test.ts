import { describe, expect, test } from 'vitest';
import { digestChunkSync } from '../src/dedup.js';
import {
  DEFAULT_INDEX_OPTIONS,
  DEFAULT_SKETCH_OPTIONS,
  estimateJaccard,
  resolveIndexOptions,
  resolveQueryOptions,
  resolveSketchOptions,
  SimilarityError,
  SimilarityIndex,
  sketchBytes,
  windowFeature,
  type Sketch,
} from '../src/similarity.js';

/**
 * splitmix32, inlined so every byte of test data is reproducible from this file alone.
 * `Math.random` would make a failure impossible to re-run, and a similarity result that cannot
 * be re-run is not a measurement.
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

/**
 * Copies `source` and rewrites `round(rate * length)` byte positions, each to a guaranteed
 * different value. Positions are drawn with replacement, so the realized mutation count can be
 * marginally lower than requested; the tests below therefore always report the *measured*
 * resemblance rather than a predicted one.
 */
function mutateBytes(source: Uint8Array, rate: number, seed: number): Uint8Array {
  const next = splitmix32(seed);
  const out = source.slice();
  const count = Math.max(1, Math.round(source.length * rate));
  for (let i = 0; i < count; i += 1) {
    const position = next() % out.length;
    const delta = 1 + (next() % 255);
    out[position] = ((out[position] as number) + delta) & 0xff;
  }
  return out;
}

const { sketchSize: SKETCH_SIZE, kGram: K_GRAM } = DEFAULT_SKETCH_OPTIONS;

/** Every distinct k-gram feature of `bytes` — the ground truth a sketch approximates. */
function featureSet(bytes: Uint8Array, kGram = K_GRAM): Set<number> {
  const features = new Set<number>();
  if (bytes.length < kGram) {
    return features;
  }
  for (let offset = 0; offset + kGram <= bytes.length; offset += 1) {
    features.add(windowFeature(bytes, offset, kGram));
  }
  return features;
}

/** Exact Jaccard resemblance of two k-gram sets, computed by brute force. */
function trueJaccard(a: Uint8Array, b: Uint8Array, kGram = K_GRAM): number {
  const left = featureSet(a, kGram);
  const right = featureSet(b, kGram);
  let intersection = 0;
  for (const feature of left) {
    if (right.has(feature)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function sketchOf(bytes: Uint8Array): Sketch {
  return sketchBytes(bytes);
}

describe('rolling hash', () => {
  /**
   * The whole point of the rolling recurrence is that it is O(1) per byte, and the whole risk is
   * that an off-by-one in the eviction term makes it hash something other than the k-byte
   * window it claims to. `windowFeature` recomputes each window from scratch, so if the two
   * agree on every position of a 4 KiB input the recurrence is right, not merely plausible.
   */
  test('sketch equals the bottom-k of independently recomputed window features', () => {
    const bytes = pseudoRandomBytes(4096, 0x5eed_0001);
    const naive = [...featureSet(bytes)].sort((a, b) => a - b).slice(0, SKETCH_SIZE);
    expect(sketchBytes(bytes).features).toEqual(naive);
  });

  test('recurrence holds for every supported k-gram width', () => {
    const bytes = pseudoRandomBytes(1024, 0x5eed_0002);
    for (const kGram of [1, 2, 3, 7, 16, 17, 31, 32]) {
      const naive = [...featureSet(bytes, kGram)].sort((a, b) => a - b).slice(0, SKETCH_SIZE);
      expect(sketchBytes(bytes, { kGram }).features, `kGram=${String(kGram)}`).toEqual(naive);
    }
  });

  test('a window feature depends only on the window, not on where it sits', () => {
    const window = pseudoRandomBytes(K_GRAM, 0x5eed_0003);
    const framed = new Uint8Array(K_GRAM + 200);
    framed.set(pseudoRandomBytes(100, 0x5eed_0004), 0);
    framed.set(window, 100);
    framed.set(pseudoRandomBytes(100, 0x5eed_0005), 100 + K_GRAM);
    expect(windowFeature(framed, 100, K_GRAM)).toBe(windowFeature(window, 0, K_GRAM));
  });
});

describe('sketchBytes', () => {
  test('produces sketchSize strictly ascending 32-bit features', () => {
    const sketch = sketchBytes(pseudoRandomBytes(32768, 0x5eed_0010));
    expect(sketch.features).toHaveLength(SKETCH_SIZE);
    for (let i = 0; i < sketch.features.length; i += 1) {
      const value = sketch.features[i] as number;
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffff_ffff);
      if (i > 0) {
        expect(value).toBeGreaterThan(sketch.features[i - 1] as number);
      }
    }
  });

  test('is deterministic across repeated calls and across separate buffers', () => {
    const bytes = pseudoRandomBytes(8192, 0x5eed_0011);
    const first = sketchBytes(bytes);
    const second = sketchBytes(bytes);
    const fromCopy = sketchBytes(bytes.slice());
    const fromRegenerated = sketchBytes(pseudoRandomBytes(8192, 0x5eed_0011));

    expect(second.features).toEqual(first.features);
    expect(fromCopy.features).toEqual(first.features);
    expect(fromRegenerated.features).toEqual(first.features);
  });

  test('identical bytes give identical sketches and resemblance exactly 1', () => {
    const bytes = pseudoRandomBytes(16384, 0x5eed_0012);
    const a = sketchBytes(bytes);
    const b = sketchBytes(bytes.slice());
    expect(a.features).toEqual(b.features);
    expect(estimateJaccard(a, b)).toBe(1);
  });

  test('honours a larger sketchSize and a different kGram', () => {
    const bytes = pseudoRandomBytes(16384, 0x5eed_0013);
    expect(sketchBytes(bytes, { sketchSize: 256 }).features).toHaveLength(256);
    expect(sketchBytes(bytes, { kGram: 8 }).features).not.toEqual(sketchBytes(bytes).features);
  });

  test('degenerate inputs: empty, sub-window, and fully repetitive', () => {
    expect(sketchBytes(new Uint8Array(0)).features).toEqual([]);

    const tiny = new Uint8Array([1, 2, 3]);
    expect(sketchBytes(tiny).features).toHaveLength(1);
    expect(sketchBytes(tiny).features[0]).toBe(windowFeature(tiny, 0, tiny.length));

    // 4 KiB of zeros has exactly one distinct 16-gram, so the sketch is one feature long.
    // A short sketch is the honest answer here, not a bug: there is only one feature to have.
    expect(sketchBytes(new Uint8Array(4096)).features).toHaveLength(1);
  });

  test('a chunk shorter than one window is hashed whole, not padded', () => {
    const a = new Uint8Array([9, 9, 9, 9]);
    const b = new Uint8Array([9, 9, 9, 9, 9]);
    expect(sketchBytes(a).features).not.toEqual(sketchBytes(b).features);
  });
});

describe('estimateJaccard', () => {
  test('is symmetric, and disjoint sketches score 0', () => {
    const a = sketchOf(pseudoRandomBytes(16384, 0x5eed_0020));
    const b = sketchOf(pseudoRandomBytes(16384, 0x5eed_0021));
    expect(estimateJaccard(a, b)).toBe(estimateJaccard(b, a));
    expect(estimateJaccard(a, b)).toBe(0);
  });

  test('empty sketches: equal to each other, unrelated to anything else', () => {
    const empty = sketchBytes(new Uint8Array(0));
    const real = sketchOf(pseudoRandomBytes(1024, 0x5eed_0022));
    expect(estimateJaccard(empty, empty)).toBe(1);
    expect(estimateJaccard(empty, real)).toBe(0);
    expect(estimateJaccard(real, empty)).toBe(0);
  });

  /**
   * Accuracy against brute-force ground truth. The bottom-k estimator is unbiased but noisy: its
   * standard error is about sqrt(J(1-J)/k), so a single pair can be off by a tenth at k = 64.
   * What must hold is that the *mean* tracks the truth and that the error shrinks like
   * 1/sqrt(k). Both are measured here; nothing is assumed.
   */
  test('tracks brute-force Jaccard, and tightens as sketchSize grows', () => {
    const rates = [0.005, 0.01, 0.03];
    const trials = 24;
    for (const rate of rates) {
      let sumEstimate = 0;
      let sumTruth = 0;
      let sumAbsoluteError = 0;
      for (let t = 0; t < trials; t += 1) {
        const base = pseudoRandomBytes(16384, 0x5eed_0030 + t * 37);
        const variant = mutateBytes(base, rate, 0x5eed_9000 + t * 41);
        const estimate = estimateJaccard(sketchOf(base), sketchOf(variant));
        const truth = trueJaccard(base, variant);
        sumEstimate += estimate;
        sumTruth += truth;
        sumAbsoluteError += Math.abs(estimate - truth);
      }
      const meanEstimate = sumEstimate / trials;
      const meanTruth = sumTruth / trials;
      const meanAbsoluteError = sumAbsoluteError / trials;
      console.log(
        `[estimator] mutation ${(rate * 100).toFixed(1)}%: ` +
          `mean estimate ${meanEstimate.toFixed(4)} vs mean true ${meanTruth.toFixed(4)}, ` +
          `MAE ${meanAbsoluteError.toFixed(4)} over ${String(trials)} pairs`,
      );
      expect(Math.abs(meanEstimate - meanTruth)).toBeLessThan(0.05);
      expect(meanAbsoluteError).toBeLessThan(0.08);
    }

    const errors: { sketchSize: number; mae: number }[] = [];
    for (const sketchSize of [64, 256, 1024]) {
      let sumAbsoluteError = 0;
      const sizeTrials = 16;
      for (let t = 0; t < sizeTrials; t += 1) {
        const base = pseudoRandomBytes(16384, 0x5eed_0040 + t * 53);
        const variant = mutateBytes(base, 0.01, 0x5eed_a000 + t * 59);
        const estimate = estimateJaccard(
          sketchBytes(base, { sketchSize }),
          sketchBytes(variant, { sketchSize }),
        );
        sumAbsoluteError += Math.abs(estimate - trueJaccard(base, variant));
      }
      errors.push({ sketchSize, mae: sumAbsoluteError / sizeTrials });
    }
    console.log(
      '[estimator] mean absolute error by sketchSize: ' +
        errors.map((e) => `${String(e.sketchSize)}=${e.mae.toFixed(4)}`).join(', '),
    );
    expect((errors[2] as { mae: number }).mae).toBeLessThan((errors[0] as { mae: number }).mae);
  }, 60_000);
});

describe('near-duplicate detection', () => {
  /**
   * The case exact dedup cannot see: one byte in a hundred is different, so the digests differ
   * completely, but 85% of the 16-grams survive.
   */
  test('1% of bytes mutated stays highly similar and is found by the index', () => {
    const base = pseudoRandomBytes(65536, 0x5eed_0050);
    const variant = mutateBytes(base, 0.01, 0x5eed_0051);

    expect(digestChunkSync(base)).not.toBe(digestChunkSync(variant));

    const baseSketch = sketchOf(base);
    const variantSketch = sketchOf(variant);
    const estimate = estimateJaccard(baseSketch, variantSketch);
    const truth = trueJaccard(base, variant);

    const index = new SimilarityIndex();
    const variantDigest = digestChunkSync(variant);
    index.add(variantDigest, variantSketch);
    const matches = index.query(baseSketch);

    console.log(
      `[1% mutation] 64 KiB chunk, 655 byte positions rewritten: ` +
        `estimated Jaccard ${estimate.toFixed(4)}, brute-force Jaccard ${truth.toFixed(4)}, ` +
        `index returned ${String(matches.length)} match(es)`,
    );

    expect(estimate).toBeGreaterThan(0.5);
    expect(truth).toBeGreaterThan(0.5);
    expect(matches).toHaveLength(1);
    expect((matches[0] as { digest: string }).digest).toBe(variantDigest);
    expect((matches[0] as { jaccard: number }).jaccard).toBe(estimate);
  });

  /**
   * Two independent high-entropy chunks. This is the unflattering direction and it is stated
   * plainly: random bytes are both incompressible and dissimilar by construction, so similarity
   * delta has nothing to offer here and the index correctly declines to propose a reference.
   * Any benchmark that shows a similarity win on random data is measuring a bug.
   */
  test('independent high-entropy chunks are dissimilar and are never proposed', () => {
    const a = pseudoRandomBytes(65536, 0x5eed_0060);
    const b = pseudoRandomBytes(65536, 0x5eed_0061);
    const sketchA = sketchOf(a);
    const sketchB = sketchOf(b);

    const estimate = estimateJaccard(sketchA, sketchB);
    const truth = trueJaccard(a, b);

    const index = new SimilarityIndex();
    index.add(digestChunkSync(a), sketchA);
    const matches = index.query(sketchB);

    console.log(
      `[independent random] estimated Jaccard ${estimate.toFixed(4)}, ` +
        `brute-force Jaccard ${truth.toFixed(6)}, candidates examined ` +
        `${String(index.stats().lastQueryCandidatesExamined)}, matches ${String(matches.length)}`,
    );

    expect(estimate).toBeLessThan(0.15);
    expect(truth).toBeLessThan(0.15);
    expect(matches).toEqual([]);
  });

  /**
   * A realistic case, and exactly how it is constructed: the same 48 KiB clip appears inside two
   * otherwise unrelated 64 KiB chunks, at different offsets — 16 KiB of unique lead-in before it
   * in one, 16 KiB of unique tail after it in the other. This is the "clip reused across a
   * thousand reaction videos" shape. Byte identity sees nothing: the digests differ and the
   * shared region is not even aligned. A k-gram set is shift-invariant, so min-hash sees the
   * shared clip regardless of where it sits.
   *
   * Expected resemblance is 48/(48+16+16) = 0.600 exactly, less the handful of 16-byte windows
   * that straddle a seam and so belong to neither side's clip region; brute force measures
   * 0.5999, which is that arithmetic and not a coincidence.
   */
  test('a shared clip at different offsets is found, though the digests differ', () => {
    const clip = pseudoRandomBytes(48 * 1024, 0x5eed_0070);
    const leadIn = pseudoRandomBytes(16 * 1024, 0x5eed_0071);
    const tail = pseudoRandomBytes(16 * 1024, 0x5eed_0072);

    const videoA = new Uint8Array(64 * 1024);
    videoA.set(leadIn, 0);
    videoA.set(clip, leadIn.length);

    const videoB = new Uint8Array(64 * 1024);
    videoB.set(clip, 0);
    videoB.set(tail, clip.length);

    expect(digestChunkSync(videoA)).not.toBe(digestChunkSync(videoB));

    const sketchA = sketchOf(videoA);
    const sketchB = sketchOf(videoB);
    const estimate = estimateJaccard(sketchA, sketchB);
    const truth = trueJaccard(videoA, videoB);

    const index = new SimilarityIndex();
    index.add(digestChunkSync(videoA), sketchA);
    const matches = index.query(sketchB);

    console.log(
      `[shared clip, misaligned] 48 KiB clip inside two 64 KiB chunks at different offsets: ` +
        `estimated Jaccard ${estimate.toFixed(4)}, brute-force Jaccard ${truth.toFixed(4)}, ` +
        `matches ${String(matches.length)}`,
    );

    expect(truth).toBeGreaterThan(0.59);
    expect(truth).toBeLessThanOrEqual(0.6);
    expect(estimate).toBeGreaterThan(0.5);
    expect(matches).toHaveLength(1);
  });

  /**
   * The banding S-curve, measured. Recall is high where a delta is worth attempting and falls
   * away where it is not; this is a property of B and R and is reported, not asserted into
   * existence. The only hard assertion is on the regime the delta layer actually depends on.
   */
  test('index recall across mutation rates follows the banding S-curve', () => {
    const trials = 40;
    const rows: string[] = [];
    let recallAtOnePercent = 0;

    for (const rate of [0.005, 0.01, 0.02, 0.05, 0.1]) {
      let found = 0;
      let sumEstimate = 0;
      for (let t = 0; t < trials; t += 1) {
        const base = pseudoRandomBytes(16384, 0x5eed_1000 + t * 17 + Math.round(rate * 10000));
        const variant = mutateBytes(base, rate, 0x5eed_2000 + t * 29);
        const index = new SimilarityIndex();
        index.add('reference', sketchOf(variant));
        sumEstimate += estimateJaccard(sketchOf(base), sketchOf(variant));
        if (index.query(sketchOf(base)).length > 0) {
          found += 1;
        }
      }
      rows.push(
        `${(rate * 100).toFixed(1)}% mutated -> mean J ${(sumEstimate / trials).toFixed(3)}, ` +
          `recall ${String(found)}/${String(trials)}`,
      );
      if (rate === 0.01) {
        recallAtOnePercent = found / trials;
      }
    }
    console.log(`[recall curve] B=16 R=4 over 64 features\n  ${rows.join('\n  ')}`);
    expect(recallAtOnePercent).toBeGreaterThan(0.9);
  }, 60_000);
});

describe('SimilarityIndex', () => {
  test('size, has, sketchFor, and idempotent add', () => {
    const index = new SimilarityIndex();
    const bytes = pseudoRandomBytes(4096, 0x5eed_0080);
    const digest = digestChunkSync(bytes);
    const sketch = sketchOf(bytes);

    expect(index.size()).toBe(0);
    expect(index.has(digest)).toBe(false);
    expect(index.sketchFor(digest)).toBeUndefined();

    index.add(digest, sketch);
    index.add(digest, sketch);

    expect(index.size()).toBe(1);
    expect(index.has(digest)).toBe(true);
    expect(index.sketchFor(digest)?.features).toEqual(sketch.features);
    expect(index.stats().bands).toBe(DEFAULT_INDEX_OPTIONS.bands);
    expect(index.stats().rowsPerBand).toBe(DEFAULT_INDEX_OPTIONS.rowsPerBand);
    expect(index.stats().digests).toBe(1);
    expect(index.stats().bandKeys).toBeGreaterThan(0);
  });

  test('owns its features: mutating the array a caller passed in cannot rewrite it', () => {
    const index = new SimilarityIndex();
    const features = [...sketchOf(pseudoRandomBytes(4096, 0x5eed_0081)).features];
    const snapshot = [...features];
    index.add('digest', { features });
    features[0] = 1;
    features.length = 3;
    expect(index.sketchFor('digest')?.features).toEqual(snapshot);
  });

  test('an empty index and an unmatched probe both return nothing', () => {
    const index = new SimilarityIndex();
    expect(index.query(sketchOf(pseudoRandomBytes(2048, 0x5eed_0082)))).toEqual([]);
    expect(index.stats().lastQueryCandidatesExamined).toBe(0);
  });

  test('minJaccard filters and limit caps, best match first', () => {
    const base = pseudoRandomBytes(32768, 0x5eed_0090);
    const index = new SimilarityIndex();

    const digests: string[] = [];
    for (const rate of [0.002, 0.005, 0.01, 0.02, 0.03]) {
      const variant = mutateBytes(base, rate, 0x5eed_0091 + Math.round(rate * 100000));
      const digest = digestChunkSync(variant);
      digests.push(digest);
      index.add(digest, sketchOf(variant));
    }

    const probe = sketchOf(base);
    const all = index.query(probe, { limit: 10, minJaccard: 0 });
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < all.length; i += 1) {
      expect((all[i - 1] as { jaccard: number }).jaccard).toBeGreaterThanOrEqual(
        (all[i] as { jaccard: number }).jaccard,
      );
    }
    // The least-mutated variant resembles the base most, so it must rank first.
    expect((all[0] as { digest: string }).digest).toBe(digests[0]);

    expect(index.query(probe, { limit: 2, minJaccard: 0 })).toHaveLength(2);

    const strict = index.query(probe, { minJaccard: 0.9, limit: 10 });
    for (const match of strict) {
      expect(match.jaccard).toBeGreaterThanOrEqual(0.9);
    }
    expect(strict.length).toBeLessThan(all.length);
  });

  test('ties break on digest ascending, so results never depend on insertion order', () => {
    const bytes = pseudoRandomBytes(4096, 0x5eed_00a0);
    const sketch = sketchOf(bytes);

    const forward = new SimilarityIndex();
    forward.add('bbbb', sketch);
    forward.add('aaaa', sketch);
    const reverse = new SimilarityIndex();
    reverse.add('aaaa', sketch);
    reverse.add('bbbb', sketch);

    const expected = [
      { digest: 'aaaa', jaccard: 1 },
      { digest: 'bbbb', jaccard: 1 },
    ];
    expect(forward.query(sketch, { limit: 10 })).toEqual(expected);
    expect(reverse.query(sketch, { limit: 10 })).toEqual(expected);
  });

  test('maxCandidates bounds the work a single query can do', () => {
    const base = pseudoRandomBytes(8192, 0x5eed_00b0);
    const index = new SimilarityIndex();
    for (let i = 0; i < 40; i += 1) {
      const variant = mutateBytes(base, 0.001, 0x5eed_00b1 + i * 7);
      index.add(digestChunkSync(variant), sketchOf(variant));
    }
    const probe = sketchOf(base);

    index.query(probe, { limit: 100, minJaccard: 0 });
    const uncapped = index.stats().lastQueryCandidatesExamined;
    expect(uncapped).toBeGreaterThan(5);
    expect(index.stats().lastQueryCandidatesSkipped).toBe(0);

    index.query(probe, { limit: 100, minJaccard: 0, maxCandidates: 5 });
    expect(index.stats().lastQueryCandidatesExamined).toBe(5);
    expect(index.stats().lastQueryCandidatesSkipped).toBeGreaterThan(0);
  });

  test('non-default banding still finds a near-duplicate', () => {
    const base = pseudoRandomBytes(16384, 0x5eed_00c0);
    const variant = mutateBytes(base, 0.01, 0x5eed_00c1);
    const index = new SimilarityIndex({ bands: 32, rowsPerBand: 2, sketchSize: 64 });
    index.add('variant', sketchOf(variant));
    expect(index.query(sketchOf(base))).toHaveLength(1);
  });

  /**
   * THE KEY TEST. The claim that makes network-scale delta possible is not "sketches estimate
   * resemblance" — it is that finding a reference in a corpus of millions costs the same as
   * finding one in a corpus of ten. A 5 000-chunk corpus of independent high-entropy chunks
   * shares no features with the probe, so the banded index must reach almost none of them, while
   * still surfacing the one chunk that does resemble it.
   */
  test('query cost does not scale with corpus size', () => {
    const corpusSize = 5000;
    const index = new SimilarityIndex();
    for (let i = 0; i < corpusSize; i += 1) {
      const bytes = pseudoRandomBytes(512, 0x5eed_3000 + i * 31);
      index.add(digestChunkSync(bytes), sketchOf(bytes));
    }
    expect(index.size()).toBe(corpusSize);

    const probe = pseudoRandomBytes(4096, 0x5eed_4000);
    const nearDuplicate = mutateBytes(probe, 0.01, 0x5eed_4001);
    const nearDigest = digestChunkSync(nearDuplicate);
    index.add(nearDigest, sketchOf(nearDuplicate));

    const started = performance.now();
    const matches = index.query(sketchOf(probe));
    const elapsedMs = performance.now() - started;
    const stats = index.stats();

    console.log(
      `[sublinearity] corpus ${String(index.size())} chunks; one query probed ` +
        `${String(stats.lastQueryBandsProbed)} band keys and scored ` +
        `${String(stats.lastQueryCandidatesExamined)} candidate(s) ` +
        `(${((stats.lastQueryCandidatesExamined / index.size()) * 100).toFixed(3)}% of the ` +
        `corpus) in ${elapsedMs.toFixed(3)} ms; found ${String(matches.length)} match(es), ` +
        `best Jaccard ${(matches[0]?.jaccard ?? 0).toFixed(4)}`,
    );

    // Sublinearity: a linear scan would score 5 001 sketches. Two orders of magnitude fewer is
    // the bar, and the measured figure printed above is far under it.
    expect(stats.lastQueryCandidatesExamined).toBeLessThan(corpusSize / 100);
    expect(stats.lastQueryBandsProbed).toBeLessThanOrEqual(DEFAULT_INDEX_OPTIONS.bands);

    // ...while still finding the needle.
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.map((match) => match.digest)).toContain(nearDigest);
    expect((matches[0] as { jaccard: number }).jaccard).toBeGreaterThan(0.5);
  }, 120_000);
});

describe('option validation', () => {
  test('resolveSketchOptions rejects unusable sketch options', () => {
    expect(resolveSketchOptions()).toEqual({ sketchSize: 64, kGram: 16 });
    expect(resolveSketchOptions({ sketchSize: 8 })).toEqual({ sketchSize: 8, kGram: 16 });

    for (const sketchSize of [0, -1, 1.5, 4097, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => sketchBytes(new Uint8Array(64), { sketchSize })).toThrow(SimilarityError);
    }
    for (const kGram of [0, -1, 2.5, 33, 1024, Number.NaN]) {
      expect(() => sketchBytes(new Uint8Array(64), { kGram })).toThrow(SimilarityError);
    }
    expect(() => sketchBytes(new Uint8Array(64), { kGram: 0 })).toThrow(/kGram/);
  });

  test('resolveIndexOptions rejects unusable banding', () => {
    expect(resolveIndexOptions()).toEqual({ bands: 16, rowsPerBand: 4, sketchSize: 64 });

    expect(() => new SimilarityIndex({ bands: 0 })).toThrow(SimilarityError);
    expect(() => new SimilarityIndex({ bands: 2.5 })).toThrow(SimilarityError);
    expect(() => new SimilarityIndex({ rowsPerBand: 0 })).toThrow(SimilarityError);
    expect(() => new SimilarityIndex({ rowsPerBand: 65 })).toThrow(SimilarityError);
    // bands * rowsPerBand must fit inside the sketch it is banding.
    expect(() => new SimilarityIndex({ bands: 17, rowsPerBand: 4, sketchSize: 64 })).toThrow(
      /must not exceed sketchSize/,
    );
    expect(() => new SimilarityIndex({ bands: 16, rowsPerBand: 4, sketchSize: 32 })).toThrow(
      SimilarityError,
    );
  });

  test('resolveQueryOptions rejects unusable query options', () => {
    expect(resolveQueryOptions()).toEqual({ limit: 4, minJaccard: 0.25, maxCandidates: 512 });

    const index = new SimilarityIndex();
    const sketch = sketchOf(pseudoRandomBytes(1024, 0x5eed_00d0));
    expect(() => index.query(sketch, { limit: 0 })).toThrow(SimilarityError);
    expect(() => index.query(sketch, { limit: 1.5 })).toThrow(SimilarityError);
    expect(() => index.query(sketch, { maxCandidates: 0 })).toThrow(SimilarityError);
    expect(() => index.query(sketch, { minJaccard: -0.01 })).toThrow(/minJaccard/);
    expect(() => index.query(sketch, { minJaccard: 1.01 })).toThrow(SimilarityError);
    expect(() => index.query(sketch, { minJaccard: Number.NaN })).toThrow(SimilarityError);
  });

  test('add rejects an empty digest, and windowFeature rejects a window outside the input', () => {
    const index = new SimilarityIndex();
    const sketch = sketchOf(pseudoRandomBytes(1024, 0x5eed_00e0));
    expect(() => index.add('', sketch)).toThrow(SimilarityError);

    const bytes = new Uint8Array(32);
    expect(() => windowFeature(bytes, 0, 33)).toThrow(SimilarityError);
    expect(() => windowFeature(bytes, 20, 16)).toThrow(SimilarityError);
    expect(() => windowFeature(bytes, -1, 4)).toThrow(SimilarityError);
    expect(() => windowFeature(bytes, 0, 0)).toThrow(SimilarityError);
  });
});
