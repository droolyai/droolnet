/**
 * Layer 2 of middle-out: the similarity index.
 *
 * Every general-purpose compressor — gzip, brotli, zstd, and every video codec — compresses its
 * input against nothing. A content-addressed network does not have to: a new chunk can be
 * stored as a delta against a chunk the network already holds. Exact dedup (layer 1) finds only
 * byte-identical chunks, and the chunks that matter most for storage are the ones that merely
 * *resemble* something already stored — a 480p rendition beside its 1080p sibling, a re-encode
 * at different settings, a clip reused across a thousand reaction videos. None of those are
 * byte-identical, so exact dedup misses them entirely.
 *
 * This file answers the one retrieval question that makes network-scale delta possible: given a
 * new chunk and a corpus of millions, which stored chunks resemble it closely enough to be
 * worth trying as a delta reference — found *without* comparing against every stored chunk?
 *
 * The answer is two pieces:
 *   1. a bottom-k min-hash sketch of each chunk's k-gram set (`sketchBytes`), which compresses
 *      a chunk of any size down to `sketchSize` 32-bit numbers while preserving an unbiased
 *      estimate of set resemblance (`estimateJaccard`);
 *   2. a banded, LSH-style inverted index over those sketches (`SimilarityIndex`), whose query
 *      cost is bounded by the band count and a candidate cap rather than by the corpus size.
 *
 * Nothing in this file decides whether a delta is actually profitable, and nothing here is
 * trusted for correctness: a sketch is a *hint*. The delta layer must verify every delta by
 * re-applying it and comparing bytes, and must fall back to standalone storage whenever the
 * delta is not strictly smaller. A false positive from this index therefore costs a little
 * wasted work and can never cost correctness or size.
 */

/**
 * Thrown for invalid sketch, index, or query options.
 *
 * Never thrown for any input byte sequence: every `Uint8Array` has a sketch, including the
 * empty one.
 */
export class SimilarityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimilarityError';
  }
}

/**
 * A bottom-k min-hash sketch: the `sketchSize` smallest distinct 32-bit feature hashes of a
 * chunk's k-gram set.
 *
 * Invariants produced by {@link sketchBytes}, and assumed by {@link estimateJaccard}:
 * `features` is sorted strictly ascending (so it is also duplicate-free), and every value is a
 * 32-bit unsigned integer. `features.length` is `min(sketchSize, number of distinct k-grams)`,
 * so a short or highly repetitive chunk yields a short sketch.
 */
export interface Sketch {
  readonly features: readonly number[];
}

/** Sketch shape knobs. Every field is optional and falls back to the default. */
export interface SketchOptions {
  /** How many features to keep — the `k` in "bottom-k". Larger is more accurate, and bigger. */
  readonly sketchSize?: number;
  /** Width in bytes of the sliding window that forms one feature. */
  readonly kGram?: number;
}

export interface ResolvedSketchOptions {
  readonly sketchSize: number;
  readonly kGram: number;
}

/**
 * `sketchSize = 64` puts the standard-error of the resemblance estimate near
 * `sqrt(J(1-J)/64)` — about ±0.05 at J = 0.5, which is far finer than the decisions the delta
 * layer makes with it. `kGram = 16` is wide enough that a 16-byte window of real media is
 * essentially never coincidentally shared, and narrow enough that a single mutated byte
 * destroys only 16 features.
 */
export const DEFAULT_SKETCH_OPTIONS: Required<SketchOptions> = Object.freeze({
  sketchSize: 64,
  kGram: 16,
});

/** Width of the feature hash, and therefore the rotation period of the rolling hash. */
const HASH_BITS = 32;

/**
 * A k-gram wider than the hash is still *computable* by the recurrence below, but it is no
 * longer a good hash: rotation amounts are taken mod 32, so two equal bytes exactly 32 apart in
 * the window contribute identical terms and cancel under XOR. The cap is about hash quality,
 * not about the recurrence being wrong.
 */
const MAX_K_GRAM = HASH_BITS;

/** Guards against an accidental `sketchSize` of a million from a caller's arithmetic. */
const MAX_SKETCH_SIZE = 4096;

/**
 * Seeds, fixed forever. A sketch is a network-visible identity for "chunks that might delta
 * well against each other", so every node must derive byte-identical features from identical
 * bytes. The values are ASCII: 'WKSD' (sketch table), 'WKST' (stratum), 'WKBD' (band).
 */
const WINDOW_TABLE_SEED = 0x574b_5344;
const STRATUM_SALT = 0x574b_5354;
const BAND_SEED = 0x574b_4244;

/**
 * splitmix32 — inlined so the window table is reproducible from this source alone, with no
 * dependency and no `Math.random`.
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

/**
 * The splitmix32 finalizer used as a standalone avalanche step.
 *
 * It is a bijection on 32-bit words (xor-shift and multiplication by an odd constant both are),
 * so it neither creates nor removes collisions — it only redistributes values. That matters:
 * bottom-k min-hash is only unbiased if "the k smallest hashes" is a uniform random sample of
 * the feature set, and the raw cyclic-polynomial hash below is linear over GF(2), so its low
 * region is *not* uniformly reachable from structured input. Mixing every window hash through
 * this before selection is what makes the estimator honest.
 */
function mix32(value: number): number {
  let z = value >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0_aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a_2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

function rotl32(value: number, bits: number): number {
  const b = bits & (HASH_BITS - 1);
  return b === 0 ? value >>> 0 : ((value << b) | (value >>> (HASH_BITS - b))) >>> 0;
}

function buildWindowTable(seed: number): Uint32Array {
  const next = splitmix32(seed);
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    table[i] = next();
  }
  return table;
}

/** One well-mixed 32-bit word per possible byte value. */
const WINDOW_TABLE = buildWindowTable(WINDOW_TABLE_SEED);

/**
 * Rotated copy of {@link WINDOW_TABLE} for the byte leaving the window, memoized per `kGram`.
 *
 * Pure memoization of a pure function of `kGram`, so it changes no observable behaviour; it
 * exists only so sketching N chunks does not rebuild the same 256-entry table N times.
 */
const EVICTION_TABLES = new Map<number, Uint32Array>();

function evictionTableFor(kGram: number): Uint32Array {
  const cached = EVICTION_TABLES.get(kGram);
  if (cached !== undefined) {
    return cached;
  }
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    table[i] = rotl32(WINDOW_TABLE[i] as number, kGram);
  }
  EVICTION_TABLES.set(kGram, table);
  return table;
}

/**
 * Cyclic-polynomial ("buzhash") hash of the window `bytes[offset, offset + length)`, before the
 * avalanche step.
 *
 * Definition, for a window of length `k` starting at `s`:
 *
 *     H(s) = rotl(T[b[s]], k-1) XOR rotl(T[b[s+1]], k-2) XOR ... XOR rotl(T[b[s+k-1]], 0)
 *
 * built here by the fold `h <- rotl(h, 1) XOR T[b]`, which reproduces exactly that sum.
 */
function windowHash(bytes: Uint8Array, offset: number, length: number): number {
  let h = 0;
  for (let i = 0; i < length; i += 1) {
    h = (rotl32(h, 1) ^ (WINDOW_TABLE[bytes[offset + i] as number] as number)) >>> 0;
  }
  return h;
}

/**
 * The feature value of a single window — the non-rolling reference implementation.
 *
 * `sketchBytes` never calls this; it uses the O(1)-per-byte recurrence instead. It is exported
 * so tests can prove the two agree on every window position, which is the only way to know the
 * recurrence was derived correctly rather than merely plausibly.
 *
 * @throws {SimilarityError} if the window is not fully inside `bytes`.
 */
export function windowFeature(bytes: Uint8Array, offset: number, length: number): number {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new SimilarityError(`offset must be a non-negative integer, received ${String(offset)}`);
  }
  if (!Number.isInteger(length) || length <= 0) {
    throw new SimilarityError(`length must be a positive integer, received ${String(length)}`);
  }
  if (offset + length > bytes.length) {
    throw new SimilarityError(
      `window [${String(offset)}, ${String(offset + length)}) exceeds input length ` +
        `${String(bytes.length)}`,
    );
  }
  return mix32(windowHash(bytes, offset, length));
}

function requireIntegerInRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SimilarityError(
      `${name} must be an integer in [${String(min)}, ${String(max)}], received ${String(value)}`,
    );
  }
}

/** Validates sketch options. Throws {@link SimilarityError} on anything unusable. */
export function resolveSketchOptions(options?: SketchOptions): ResolvedSketchOptions {
  const sketchSize = options?.sketchSize ?? DEFAULT_SKETCH_OPTIONS.sketchSize;
  const kGram = options?.kGram ?? DEFAULT_SKETCH_OPTIONS.kGram;

  requireIntegerInRange('sketchSize', sketchSize, 1, MAX_SKETCH_SIZE);
  requireIntegerInRange('kGram', kGram, 1, MAX_K_GRAM);

  return { sketchSize, kGram };
}

/**
 * Selects the `capacity` smallest distinct values from a stream, in one pass.
 *
 * A binary max-heap of at most `capacity` entries plus a membership `Set`: each candidate is
 * either already present (skip), smaller than the current maximum (replace it), or too large
 * (skip). That is O(n log capacity) time and O(capacity) space for a chunk of n bytes — the
 * alternative of collecting every window hash and sorting would be O(n log n) time and O(n)
 * space, which for a 128 KiB chunk means 131 072 numbers instead of 64.
 */
class BottomKSelector {
  readonly #capacity: number;
  readonly #heap: number[] = [];
  readonly #present = new Set<number>();

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  offer(value: number): void {
    if (this.#present.has(value)) {
      return;
    }
    const heap = this.#heap;
    if (heap.length < this.#capacity) {
      this.#present.add(value);
      heap.push(value);
      let child = heap.length - 1;
      while (child > 0) {
        const parent = (child - 1) >> 1;
        if ((heap[parent] as number) >= (heap[child] as number)) {
          break;
        }
        const swap = heap[parent] as number;
        heap[parent] = heap[child] as number;
        heap[child] = swap;
        child = parent;
      }
      return;
    }

    const largest = heap[0] as number;
    if (value >= largest) {
      return;
    }
    this.#present.delete(largest);
    this.#present.add(value);
    heap[0] = value;

    let parent = 0;
    for (;;) {
      const left = parent * 2 + 1;
      if (left >= heap.length) {
        break;
      }
      const right = left + 1;
      let bigger = left;
      if (right < heap.length && (heap[right] as number) > (heap[left] as number)) {
        bigger = right;
      }
      if ((heap[parent] as number) >= (heap[bigger] as number)) {
        break;
      }
      const swap = heap[parent] as number;
      heap[parent] = heap[bigger] as number;
      heap[bigger] = swap;
      parent = bigger;
    }
  }

  /** The selected values, sorted strictly ascending. */
  drain(): number[] {
    return this.#heap.slice().sort((a, b) => a - b);
  }
}

/**
 * Bottom-k min-hash sketch of `bytes`.
 *
 * Every `kGram`-byte window is hashed and the `sketchSize` smallest distinct hash values are
 * kept, sorted ascending. The window hash uses the rolling recurrence
 *
 *     H(s+1) = rotl(H(s), 1) XOR rotl(T[b[s]], k) XOR T[b[s+k]]
 *
 * which is exact: rotating `H(s)` left by one turns each term `rotl(T[b[s+j]], k-1-j)` into
 * `rotl(T[b[s+j]], k-j)`, so the outgoing byte's term becomes `rotl(T[b[s]], k)` and is removed
 * by XOR, and the incoming byte enters unrotated. Sketching is therefore O(n) in the chunk
 * length rather than O(n·k), which is what makes it affordable to sketch every chunk of every
 * upload.
 *
 * Bottom-k rather than k independent permutations: one pass over the bytes produces the entire
 * sketch, instead of k passes or k hashes per window. The price is that the resemblance
 * estimator must be the bottom-k estimator (see {@link estimateJaccard}) rather than the
 * "fraction of positions that agree" formula that k-permutation min-hash allows.
 *
 * Inputs shorter than `kGram` cannot form a window, so the whole input is hashed as a single
 * feature; the empty input has no features at all.
 *
 * @throws {SimilarityError} only for invalid options, never for any byte sequence.
 */
export function sketchBytes(bytes: Uint8Array, options?: SketchOptions): Sketch {
  const { sketchSize, kGram } = resolveSketchOptions(options);
  const length = bytes.length;

  if (length === 0) {
    return { features: Object.freeze<number[]>([]) };
  }
  if (length < kGram) {
    return { features: Object.freeze([mix32(windowHash(bytes, 0, length))]) };
  }

  const eviction = evictionTableFor(kGram);
  const selector = new BottomKSelector(sketchSize);

  let h = windowHash(bytes, 0, kGram);
  selector.offer(mix32(h));
  for (let i = kGram; i < length; i += 1) {
    h =
      (rotl32(h, 1) ^
        (eviction[bytes[i - kGram] as number] as number) ^
        (WINDOW_TABLE[bytes[i] as number] as number)) >>>
      0;
    selector.offer(mix32(h));
  }

  return { features: Object.freeze(selector.drain()) };
}

/**
 * Estimated Jaccard resemblance of the two chunks the sketches were taken from, in `[0, 1]`.
 *
 * This is the standard bottom-k (a.k.a. KMV / MINCOUNT) estimator: let `k` be the smaller of
 * the two sketch sizes, take the `k` smallest distinct values of the union of the two feature
 * lists, and report the fraction of those that occur in *both*. Because the hash is a fixed
 * function of content, those `k` values are exactly the bottom-k of the union of the two
 * underlying k-gram sets, and each of them lands in the intersection independently with
 * probability `J` — so the fraction is an unbiased estimate of `J`.
 *
 * Both lists must be sorted strictly ascending, which {@link sketchBytes} guarantees; the merge
 * walk below is a single pass over both with no allocation.
 *
 * Exactly-equal sketches return exactly 1. Sketches with no value in common return exactly 0.
 * Two empty sketches are equal and return 1; an empty sketch against a non-empty one returns 0,
 * since there is no evidence of any shared content.
 */
export function estimateJaccard(a: Sketch, b: Sketch): number {
  const left = a.features;
  const right = b.features;
  const k = Math.min(left.length, right.length);
  if (k === 0) {
    return left.length === right.length ? 1 : 0;
  }

  let i = 0;
  let j = 0;
  let taken = 0;
  let shared = 0;
  while (taken < k && (i < left.length || j < right.length)) {
    const lv = i < left.length ? (left[i] as number) : Number.POSITIVE_INFINITY;
    const rv = j < right.length ? (right[j] as number) : Number.POSITIVE_INFINITY;
    if (lv === rv) {
      shared += 1;
      i += 1;
      j += 1;
    } else if (lv < rv) {
      i += 1;
    } else {
      j += 1;
    }
    taken += 1;
  }
  return shared / k;
}

/** Banding knobs for {@link SimilarityIndex}. */
export interface IndexOptions {
  /** Number of bands `B`: how many independent chances a similar pair gets to collide. */
  readonly bands?: number;
  /** Features per band `R`: how strict each individual chance is. */
  readonly rowsPerBand?: number;
  /** Sketch size the index is built for; `bands * rowsPerBand` must not exceed it. */
  readonly sketchSize?: number;
}

export interface ResolvedIndexOptions {
  readonly bands: number;
  readonly rowsPerBand: number;
  readonly sketchSize: number;
}

/**
 * `B = 16`, `R = 4` over a 64-feature sketch. A pair with resemblance `J` collides in a given
 * band with probability about `J^R` and is therefore found with probability about
 * `1 - (1 - J^R)^B`: 0.99 at `J = 0.7`, 0.64 at `J = 0.5`, 0.06 at `J = 0.25`, 0.002 at
 * `J = 0.1`. That S-curve is the whole design: near-duplicates are found, unrelated chunks are
 * never even looked at. `test/similarity.test.ts` measures the curve rather than trusting it.
 */
export const DEFAULT_INDEX_OPTIONS: Required<IndexOptions> = Object.freeze({
  bands: 16,
  rowsPerBand: 4,
  sketchSize: DEFAULT_SKETCH_OPTIONS.sketchSize,
});

const MAX_BANDS = 1024;
const MAX_ROWS_PER_BAND = 64;

/** Validates banding options. Throws {@link SimilarityError} on anything unusable. */
export function resolveIndexOptions(options?: IndexOptions): ResolvedIndexOptions {
  const bands = options?.bands ?? DEFAULT_INDEX_OPTIONS.bands;
  const rowsPerBand = options?.rowsPerBand ?? DEFAULT_INDEX_OPTIONS.rowsPerBand;
  const sketchSize = options?.sketchSize ?? DEFAULT_INDEX_OPTIONS.sketchSize;

  requireIntegerInRange('bands', bands, 1, MAX_BANDS);
  requireIntegerInRange('rowsPerBand', rowsPerBand, 1, MAX_ROWS_PER_BAND);
  requireIntegerInRange('sketchSize', sketchSize, 1, MAX_SKETCH_SIZE);

  if (bands * rowsPerBand > sketchSize) {
    throw new SimilarityError(
      `bands * rowsPerBand (${String(bands)} * ${String(rowsPerBand)} = ` +
        `${String(bands * rowsPerBand)}) must not exceed sketchSize (${String(sketchSize)})`,
    );
  }
  return { bands, rowsPerBand, sketchSize };
}

/** Query knobs for {@link SimilarityIndex.query}. */
export interface QueryOptions {
  /** Most matches to return. The delta layer only needs a handful of reference candidates. */
  readonly limit?: number;
  /** Minimum estimated resemblance to report. Below this a delta rarely pays for itself. */
  readonly minJaccard?: number;
  /** Hard ceiling on candidates scored, so query cost cannot grow with the corpus. */
  readonly maxCandidates?: number;
}

export interface ResolvedQueryOptions {
  readonly limit: number;
  readonly minJaccard: number;
  readonly maxCandidates: number;
}

/**
 * `minJaccard = 0.25` because below roughly a quarter shared content a delta plus its reference
 * pointer stops beating plain standalone compression often enough to be worth the attempt; the
 * delta layer still verifies and still falls back, so this is a work-saving threshold, not a
 * correctness one. `limit = 4` reference candidates is enough to pick a good one by measurement.
 */
export const DEFAULT_QUERY_OPTIONS: Required<QueryOptions> = Object.freeze({
  limit: 4,
  minJaccard: 0.25,
  maxCandidates: 512,
});

export interface SimilarityMatch {
  readonly digest: string;
  readonly jaccard: number;
}

export interface SimilarityIndexStats {
  /** Sketches held. */
  readonly digests: number;
  /** Distinct band keys held, across all bands. */
  readonly bandKeys: number;
  readonly bands: number;
  readonly rowsPerBand: number;
  /** Band keys probed by the most recent `query` (0 if none has run). */
  readonly lastQueryBandsProbed: number;
  /** Distinct candidate digests scored by the most recent `query`. */
  readonly lastQueryCandidatesExamined: number;
  /** Candidates the most recent `query` skipped because `maxCandidates` was reached. */
  readonly lastQueryCandidatesSkipped: number;
  /** Matches the most recent `query` returned. */
  readonly lastQueryMatches: number;
}

/**
 * Banded (LSH) inverted index over sketches: the thing that turns "compress against everything
 * the network already holds" from a quadratic fantasy into a map lookup.
 *
 * Banding, and one deliberate departure from the textbook. Textbook LSH slices the sketch by
 * *array position* — band `b` is features `[b·R, (b+1)·R)`. That is correct for k-permutation
 * min-hash, where position `i` always holds the minimum under permutation `i`, but it is wrong
 * for bottom-k: a single extra small feature in one sketch shifts every later position, so one
 * differing feature desynchronizes all downstream bands at once. Recall collapses from the
 * `1 - (1 - J^R)^B` the band count promises to roughly the `J^R` of the first band alone.
 *
 * So bands here are chosen by *value*, not by position: each feature is assigned to one of `B`
 * strata by a second hash of the feature value alone, and band `b` is keyed on the `R` smallest
 * features in stratum `b`. Membership is now a pure function of the feature, so a differing
 * feature perturbs only its own band and the `B` bands really are independent trials. That
 * restores the S-curve — and it is measured, not assumed: see the recall figures in
 * `test/similarity.test.ts`.
 *
 * A stratum holding fewer than `R` features is keyed on what it does hold, with its own arity
 * folded into the key, so a short sketch is still reachable. A stratum holding *nothing* emits
 * no key at all: keying emptiness would make two chunks that share no content collide merely by
 * sharing a gap, which would poison the candidate set with pure noise.
 *
 * Band-key collisions are harmless by construction. A collision can only add a candidate, and
 * every candidate is then scored with {@link estimateJaccard} and filtered — so the index can
 * cost extra work but can never report a match it did not measure.
 */
export class SimilarityIndex {
  readonly #bands: number;
  readonly #rowsPerBand: number;
  readonly #sketchSize: number;
  readonly #sketches = new Map<string, Sketch>();
  readonly #buckets = new Map<number, Set<string>>();

  #lastBandsProbed = 0;
  #lastCandidatesExamined = 0;
  #lastCandidatesSkipped = 0;
  #lastMatches = 0;

  /** Validates options eagerly, so bad banding throws here and not on first `add`. */
  constructor(options?: IndexOptions) {
    const resolved = resolveIndexOptions(options);
    this.#bands = resolved.bands;
    this.#rowsPerBand = resolved.rowsPerBand;
    this.#sketchSize = resolved.sketchSize;
  }

  /**
   * Registers `sketch` under the content address `digest`.
   *
   * Idempotent: a digest is a content address, so re-adding one describes the same bytes and the
   * same sketch, and the second call is a no-op. The features are copied, because the index must
   * own them — a caller mutating the array it passed in must not be able to rewrite the index.
   *
   * @throws {SimilarityError} if `digest` is empty.
   */
  add(digest: string, sketch: Sketch): void {
    if (digest.length === 0) {
      throw new SimilarityError('digest must be a non-empty string');
    }
    if (this.#sketches.has(digest)) {
      return;
    }
    const features = Object.freeze(sketch.features.slice());
    this.#sketches.set(digest, Object.freeze({ features }));

    for (const key of this.#bandKeys(features)) {
      const bucket = this.#buckets.get(key);
      if (bucket === undefined) {
        this.#buckets.set(key, new Set([digest]));
      } else {
        bucket.add(digest);
      }
    }
  }

  /**
   * Stored chunks that resemble `sketch`, best first.
   *
   * Cost is `O(bands)` map lookups plus at most `maxCandidates` sketch comparisons, each
   * `O(sketchSize)`. Nothing in that expression mentions the number of stored chunks — the
   * corpus can grow by six orders of magnitude and a query does the same amount of work. That
   * property is the entire reason this class exists, and `test/similarity.test.ts` measures it
   * against a 5 000-chunk corpus rather than asserting it.
   *
   * Ties in resemblance are broken by digest, ascending, so the result is fully determined by
   * the index contents and never by insertion order or platform.
   */
  query(sketch: Sketch, options?: QueryOptions): SimilarityMatch[] {
    const { limit, minJaccard, maxCandidates } = resolveQueryOptions(options);

    const keys = this.#bandKeys(sketch.features);
    const candidates = new Set<string>();
    let skipped = 0;

    for (const key of keys) {
      const bucket = this.#buckets.get(key);
      if (bucket === undefined) {
        continue;
      }
      for (const digest of bucket) {
        if (candidates.has(digest)) {
          continue;
        }
        if (candidates.size >= maxCandidates) {
          skipped += 1;
          continue;
        }
        candidates.add(digest);
      }
    }

    const matches: SimilarityMatch[] = [];
    for (const digest of candidates) {
      const stored = this.#sketches.get(digest);
      if (stored === undefined) {
        continue;
      }
      const jaccard = estimateJaccard(sketch, stored);
      if (jaccard >= minJaccard) {
        matches.push({ digest, jaccard });
      }
    }
    matches.sort((x, y) => y.jaccard - x.jaccard || (x.digest < y.digest ? -1 : 1));

    const result = matches.length > limit ? matches.slice(0, limit) : matches;

    this.#lastBandsProbed = keys.length;
    this.#lastCandidatesExamined = candidates.size;
    this.#lastCandidatesSkipped = skipped;
    this.#lastMatches = result.length;
    return result;
  }

  size(): number {
    return this.#sketches.size;
  }

  has(digest: string): boolean {
    return this.#sketches.has(digest);
  }

  /** The stored sketch, so the delta layer can re-score a reference without re-reading bytes. */
  sketchFor(digest: string): Sketch | undefined {
    return this.#sketches.get(digest);
  }

  stats(): SimilarityIndexStats {
    return {
      digests: this.#sketches.size,
      bandKeys: this.#buckets.size,
      bands: this.#bands,
      rowsPerBand: this.#rowsPerBand,
      lastQueryBandsProbed: this.#lastBandsProbed,
      lastQueryCandidatesExamined: this.#lastCandidatesExamined,
      lastQueryCandidatesSkipped: this.#lastCandidatesSkipped,
      lastQueryMatches: this.#lastMatches,
    };
  }

  /** The configured sketch size this index was built for. */
  get sketchSize(): number {
    return this.#sketchSize;
  }

  /**
   * The band keys of a sketch: one per non-empty stratum, keyed on that stratum's `R` smallest
   * features (or all of them, when it holds fewer).
   */
  #bandKeys(features: readonly number[]): number[] {
    if (features.length === 0) {
      return [];
    }
    const bandCount = this.#bands;
    const rows = this.#rowsPerBand;

    const strata: number[][] = [];
    for (let b = 0; b < bandCount; b += 1) {
      strata.push([]);
    }
    for (const feature of features) {
      const stratum = mix32((feature ^ STRATUM_SALT) >>> 0) % bandCount;
      (strata[stratum] as number[]).push(feature);
    }

    const keys: number[] = [];
    for (let b = 0; b < bandCount; b += 1) {
      const stratum = strata[b] as number[];
      if (stratum.length === 0) {
        continue;
      }
      // Sorted so the key depends on the stratum's *set*, never on the order features arrived
      // in; `sketchBytes` already delivers them ascending, so this is normally a no-op.
      stratum.sort((x, y) => x - y);
      const arity = Math.min(rows, stratum.length);
      let key = mix32((BAND_SEED ^ b) >>> 0);
      key = mix32((key ^ arity) >>> 0);
      for (let r = 0; r < arity; r += 1) {
        key = mix32((key ^ (stratum[r] as number)) >>> 0);
      }
      keys.push(key);
    }
    return keys;
  }
}

/** Validates query options. Throws {@link SimilarityError} on anything unusable. */
export function resolveQueryOptions(options?: QueryOptions): ResolvedQueryOptions {
  const limit = options?.limit ?? DEFAULT_QUERY_OPTIONS.limit;
  const minJaccard = options?.minJaccard ?? DEFAULT_QUERY_OPTIONS.minJaccard;
  const maxCandidates = options?.maxCandidates ?? DEFAULT_QUERY_OPTIONS.maxCandidates;

  requireIntegerInRange('limit', limit, 1, Number.MAX_SAFE_INTEGER);
  requireIntegerInRange('maxCandidates', maxCandidates, 1, Number.MAX_SAFE_INTEGER);
  if (!Number.isFinite(minJaccard) || minJaccard < 0 || minJaccard > 1) {
    throw new SimilarityError(
      `minJaccard must be a finite number in [0, 1], received ${String(minJaccard)}`,
    );
  }
  return { limit, minJaccard, maxCandidates };
}
