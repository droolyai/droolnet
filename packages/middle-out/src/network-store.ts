/**
 * The storage layer: content-defined chunking, exact dedup, and similarity-indexed delta
 * compression against everything the store already holds.
 *
 * THE ASSUMPTION THIS FILE BREAKS
 * ------------------------------
 * gzip, brotli, zstd, AV1 — every compressor in production compresses its input *in isolation*.
 * That is not a law; it is an artefact of the interface. A compressor is handed one buffer and
 * asked for a smaller one, so the only redundancy it can exploit is redundancy inside that buffer.
 *
 * A content-addressed network does not have that constraint. When an upload arrives, the store
 * already holds a corpus, and the new bytes can be coded against it. Exact dedup is the trivial
 * form of this and is table stakes: identical chunk, stored once. The interesting form is that a
 * chunk which merely *resembles* something already stored can be kept as a verified delta against
 * it — a re-encode at different settings, a remux, a clip reused across a thousand videos, a
 * ladder rung that preserved most of its segments. None of those are byte-identical, so exact
 * dedup misses them completely, and standalone compression cannot see the reference at all.
 *
 * The consequence is the interesting part: **storage efficiency is a function of corpus size.**
 * Each upload enriches the corpus, which makes the next upload cheaper to store. That is a
 * network effect on a physical resource, and it runs the opposite way from centralized video,
 * where each new user costs the operator more. `scripts/scale-benchmark.ts` measures the curve.
 *
 * TWO GUARANTEES, BOTH ENFORCED HERE RATHER THAN ASSERTED
 * ------------------------------------------------------
 * 1. **Never worse.** A delta is stored only when its compressed bytes *plus* its 32-byte
 *    reference pointer are strictly smaller than compressing the chunk standalone. That test
 *    lives in {@link chooseEncoding} and is a comparison of two measured lengths, not an estimate.
 *    So the store cannot lose to plain brotli on any input, including inputs designed to defeat
 *    it. On incompressible, mutually dissimilar data every chunk goes standalone and the ratio is
 *    ~1.00 — see the control curve in `SCALE.md`, which reports exactly that.
 *
 * 2. **Verified at write time.** `chooseEncoding` already decompresses, applies and byte-compares
 *    a candidate delta before it is eligible. This class then does the *end-to-end* check: after
 *    a record is inserted it resolves the record back out of the store — walking whatever delta
 *    chain it now sits on — and byte-compares against the original chunk. Only then is the chunk
 *    considered stored. A record that fails is replaced with a standalone one, which is
 *    unconditionally correct. Corruption is therefore not "unlikely"; there is no code path that
 *    stores a record whose reconstruction has not already been performed and checked.
 *
 * WHY DELTA CHAINS ARE BOUNDED
 * ----------------------------
 * A delta may reference a chunk that is itself a delta. Allowing that is worth real bytes: the
 * best reference for rung 3 of a ladder is often rung 2, not the source. But an unbounded chain
 * would buy those bytes with two costs that both grow linearly in its length:
 *
 *   - **Reconstruction cost.** Reading one chunk at depth `d` means `d` brotli decompressions and
 *     `d` delta applications, serially — they cannot be parallelized, because each step's output
 *     is the next step's reference. Depth is directly a read-latency multiplier.
 *   - **Failure-domain size.** Every record in a chain is a single point of failure for every
 *     record downstream of it. A chain of length `d` means one lost or unavailable chunk takes
 *     `d` chunks with it. Bounding depth bounds the blast radius of any one loss, which is the
 *     property that matters on a network where availability is per-chunk and not guaranteed.
 *
 * {@link DEFAULT_MAX_CHAIN_DEPTH} is 4: enough that a four-rung ladder can chain rung to rung,
 * small enough that a read is at most four decode steps and a loss takes at most four chunks.
 * Cycles are impossible by construction — a reference must already be in the store before a
 * record can point at it, so references always point strictly backwards in insertion order, and a
 * digest is a content address so it cannot later be rebound. {@link NetworkStore.reconstruct}
 * nonetheless carries an explicit visited-set and depth check, because "impossible by
 * construction" is an argument about today's code and a runtime check is a fact about every run.
 */

import { chunkBytes, type ChunkingOptions } from './chunking.js';
import { digestChunkSync } from './dedup.js';
import {
  chooseEncoding,
  decodeDeltaPayload,
  decodeStandalonePayload,
  encodeDelta,
  REFERENCE_POINTER_BYTES,
} from './delta.js';
import {
  DEFAULT_SKETCH_OPTIONS,
  SimilarityIndex,
  sketchBytes,
  type IndexOptions,
  type QueryOptions,
  type Sketch,
  type SketchOptions,
} from './similarity.js';

/** Thrown for unusable options, and for store invariant violations that must never be silent. */
export class NetworkStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkStoreError';
  }
}

/**
 * Longest delta chain the store will build. See the header for why a bound exists at all and why
 * this is the number.
 */
export const DEFAULT_MAX_CHAIN_DEPTH = 4;

/**
 * Reference candidates put through a real delta encode before one is chosen.
 *
 * The similarity index ranks candidates by *estimated* resemblance, which is a proxy. Resemblance
 * and delta size are correlated but not the same thing — a chunk sharing 90 % of its k-grams in a
 * scrambled order deltas worse than one sharing 80 % in place. So each candidate is actually
 * encoded and the one with the smallest *raw* delta wins. Raw, not compressed: `encodeDelta` is
 * cheap (single pass, no entropy coding), while brotli quality 11 is the expensive step, so this
 * buys a measured choice for a small fraction of the cost of measuring it exactly.
 */
export const DEFAULT_REFERENCE_CANDIDATES = 4;

/**
 * Banding the store asks for, which is deliberately looser than `similarity.ts`'s own default.
 *
 * `SimilarityIndex` defaults to `B = 16, R = 4`, which is the right default for a general
 * similarity query: high precision, so a caller gets few and good answers. The store's problem is
 * not symmetric, though, and the asymmetry points the other way.
 *
 *   - A **false candidate** costs one `encodeDelta` — a single linear pass with no entropy coding.
 *     It is then simply not chosen, because the candidate loop keeps the smallest raw delta and
 *     `chooseEncoding` applies the never-worse rule on top of that. A false candidate cannot
 *     produce a wrong answer or a larger record; it can only waste microseconds.
 *   - A **missed candidate** costs the entire saving on that chunk — tens of kilobytes, for the
 *     lifetime of the stored chunk.
 *
 * With costs that lopsided the store should buy recall. `B = 32, R = 2` gives each band a
 * per-band collision probability of about `J^2` instead of `J^4`, so the `1 - (1 - J^R)^B` curve
 * moves sharply left: at `J = 0.5` recall goes from about 0.64 to about 0.99993. Measured on a
 * source-plus-ladder-plus-variants corpus, that took delta hits from 20/33 chunks to 26/33 and the
 * effective ratio from 2.06 to 2.45.
 *
 * `R = 1` measured better still (28/33, ratio 2.62) and is *not* chosen. A band keyed on a single
 * feature is the loosest possible predicate, and while its candidate count also measured flat up
 * to a few hundred chunks, single-feature collisions are exactly the thing that stops being rare
 * as a corpus grows into the millions. `R = 2` keeps a real per-band predicate. That is a
 * deliberate decision to leave measured gain on the table for a scaling property, and it is
 * recorded here so the choice is visible rather than looking like an oversight.
 */
export const DEFAULT_STORE_INDEX_OPTIONS: Required<Omit<IndexOptions, 'sketchSize'>> =
  Object.freeze({ bands: 32, rowsPerBand: 2 });

/**
 * Query knobs the store asks for: eight candidates, and a low resemblance floor.
 *
 * `minJaccard` is dropped to 0.10 from the similarity layer's 0.25 for the same reason the banding
 * is looser. 0.25 is a sensible work-saving floor when the caller will trust the answer; here the
 * answer is *measured* immediately afterwards by a real delta encode, so a weak candidate that
 * cannot pay for itself is discarded on evidence a few microseconds later. Raising recall costs
 * cheap work; lowering it costs stored bytes. `limit = 8` then feeds
 * {@link DEFAULT_REFERENCE_CANDIDATES} with more than it needs, so the four it actually encodes are
 * the four best-ranked rather than the four that happened to be returned.
 */
export const DEFAULT_STORE_QUERY_OPTIONS: Required<QueryOptions> = Object.freeze({
  limit: 8,
  minJaccard: 0.1,
  maxCandidates: 512,
});

/** How a chunk's bytes are physically kept. */
export type RecordKind = 'standalone' | 'delta';

/** One stored chunk. Immutable once inserted, because its digest is its content address. */
export interface ChunkRecord {
  /** sha256 of the chunk's plaintext, lowercase hex. The store's key. */
  readonly digest: string;
  /** Plaintext length, so `reconstruct` can size its output without decoding first. */
  readonly length: number;
  readonly kind: RecordKind;
  /** brotli-compressed standalone bytes, or the brotli-compressed delta. */
  readonly payload: Uint8Array;
  /** Digest of the reference this delta is coded against; `null` for a standalone record. */
  readonly referenceDigest: string | null;
  /** `payload.length`, plus {@link REFERENCE_POINTER_BYTES} when a reference is carried. */
  readonly storedBytes: number;
  /** Deltas that must be applied to read this chunk. 0 for standalone. Bounded by the store. */
  readonly depth: number;
  /**
   * What this chunk would have cost stored standalone, measured at ingest.
   *
   * Kept per record because it is the only way to state the delta saving honestly: the saving is
   * against a real brotli quality 11 measurement of that exact chunk, taken at the moment the
   * decision was made, not against a re-derived estimate.
   */
  readonly standaloneBaselineBytes: number;
}

/** What one {@link NetworkStore.ingest} did. Enough to reconstruct the input exactly. */
export interface IngestReceipt {
  /** Chunk digests in input order. This is the manifest. */
  readonly chunkDigests: readonly string[];
  /** Plaintext length of the ingested input. */
  readonly totalBytes: number;
  /** Chunks whose digest was already in the store: zero new stored bytes. */
  readonly exactHits: number;
  /** Chunks newly stored as a verified delta. */
  readonly deltaChunks: number;
  /** Chunks newly stored standalone. */
  readonly standaloneChunks: number;
  /** Stored bytes this ingest added. Zero for a re-ingest of identical bytes. */
  readonly newStoredBytes: number;
  /** What this ingest would have added under exact dedup with per-chunk brotli, measured. */
  readonly dedupOnlyBytes: number;
}

/** Cumulative, measured storage accounting. Every field is a count or a sum of real lengths. */
export interface NetworkStoreStats {
  /** Plaintext bytes handed to `ingest`, counting re-ingests of identical bytes. */
  readonly ingestedBytes: number;
  /** Sum of `storedBytes` over every stored record. The number that matters. */
  readonly storedBytes: number;
  /** Chunk *references* seen across all ingests. `exactHits + deltaChunks + standaloneChunks`. */
  readonly chunks: number;
  readonly exactHits: number;
  readonly deltaChunks: number;
  readonly standaloneChunks: number;
  /**
   * `dedupOnlyBytes - storedBytes`: what similarity delta saved beyond exact dedup.
   *
   * Both terms are measured, so this is a difference of two real numbers and never negative —
   * the never-worse rule makes every record's `storedBytes <= standaloneBaselineBytes`.
   */
  readonly deltaBytesSaved: number;
  /** `ingestedBytes / storedBytes`. 1 when nothing compressed and nothing deduplicated. */
  readonly effectiveRatio: number;
  /** Distinct chunks held: `deltaChunks + standaloneChunks`. */
  readonly uniqueChunks: number;
  /**
   * What the same input would cost under exact dedup + per-chunk brotli quality 11.
   *
   * This is not a model. It is the sum of `standaloneBaselineBytes` over the records actually
   * stored, i.e. the brotli measurement `chooseEncoding` took of every distinct chunk. The
   * dedup-only strategy in `scripts/scale-benchmark.ts` *is* this number, on identical input with
   * identical chunking, which is why the comparison there costs no extra compression work and has
   * no opportunity to differ in methodology.
   */
  readonly dedupOnlyBytes: number;
  /**
   * `chunks * 32`: the manifest overhead this store does not count in `storedBytes`.
   *
   * Disclosed because a receipt is a list of 32-byte digests and something has to hold it. It is
   * excluded from `effectiveRatio` because the dedup-only baseline pays exactly the same
   * per-chunk manifest cost, so including it in both would only compress the difference between
   * the strategies. `storedBytesWithManifest` is provided so a reader can check that.
   */
  readonly manifestBytes: number;
  /** `storedBytes + manifestBytes`. */
  readonly storedBytesWithManifest: number;
  /** Longest chain actually built. Never exceeds the configured bound. */
  readonly maxObservedChainDepth: number;
  /** Similarity queries run: one per chunk that was not an exact hit. */
  readonly similarityQueries: number;
  /**
   * Total candidate sketches scored across all queries.
   *
   * The sublinearity evidence. Banded LSH means a query probes a fixed number of buckets and
   * scores whatever is in them, so this divided by `similarityQueries` should stay roughly flat
   * as the corpus grows rather than tracking `uniqueChunks`. The benchmark prints both.
   */
  readonly similarityCandidatesExamined: number;
  /** `similarityCandidatesExamined / similarityQueries`, or 0 when no query has run. */
  readonly meanCandidatesPerQuery: number;
  /** Sketches in the similarity index. Equals `uniqueChunks`. */
  readonly indexSize: number;
  /**
   * Times the end-to-end write-time verification rejected a record and forced a standalone.
   *
   * Reported because a silent zero is worth more than a promise. If this is ever non-zero there
   * is a bug in the delta layer, and the store degraded safely instead of storing corruption.
   */
  readonly verificationFallbacks: number;
}

export interface NetworkStoreOptions {
  readonly chunking?: ChunkingOptions;
  readonly sketch?: SketchOptions;
  readonly index?: IndexOptions;
  readonly query?: QueryOptions;
  /** Longest delta chain to build. Defaults to {@link DEFAULT_MAX_CHAIN_DEPTH}. */
  readonly maxChainDepth?: number;
  /** Candidates to delta-encode before choosing. Defaults to {@link DEFAULT_REFERENCE_CANDIDATES}. */
  readonly referenceCandidates?: number;
}

/**
 * Banding options for a store's index, made consistent with the sketch size it will actually see.
 *
 * `SimilarityIndex` requires `bands * rowsPerBand <= sketchSize`, and rightly so: a band keyed on
 * more features than a sketch can hold is not a band. But a caller who shrinks the sketch and says
 * nothing about banding has expressed a coherent intent — smaller sketches, default banding
 * strategy — and should get it rather than a validation error about numbers they never supplied.
 * So an unspecified `bands` is scaled down to `floor(sketchSize / rowsPerBand)`, keeping the
 * default rows-per-band and therefore the default per-band strictness.
 *
 * The cost is stated rather than hidden: fewer bands means fewer independent chances for a similar
 * pair to collide, so recall drops — the `1 - (1 - J^R)^B` curve moves left with `B`. That is the
 * real price of a smaller sketch and it is the caller's choice to pay. Anything the caller *does*
 * specify is passed through untouched, so an explicit banding still validates and still throws.
 */
function resolveStoreIndexOptions(
  index: IndexOptions | undefined,
  sketchSize: number | undefined,
): IndexOptions {
  const rowsPerBand = index?.rowsPerBand ?? DEFAULT_STORE_INDEX_OPTIONS.rowsPerBand;
  const effectiveSketchSize = index?.sketchSize ?? sketchSize ?? DEFAULT_SKETCH_OPTIONS.sketchSize;

  // An explicit band count is the caller's decision and is passed through to be validated, even
  // if it will be rejected. Only an *unspecified* one is fitted to the sketch.
  const bands =
    index?.bands ??
    Math.min(
      DEFAULT_STORE_INDEX_OPTIONS.bands,
      Math.max(1, Math.floor(effectiveSketchSize / rowsPerBand)),
    );
  return { bands, rowsPerBand, sketchSize: effectiveSketchSize };
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

/** One reference candidate, with its delta already encoded and measured. */
interface ReferenceCandidate {
  readonly digest: string;
  readonly bytes: Uint8Array;
  readonly depth: number;
  readonly jaccard: number;
  readonly rawDeltaBytes: number;
}

/**
 * An in-memory model of WokeNet's storage layer.
 *
 * Deliberately in-memory and single-process: this measures the *compression* claim, and a real
 * node would put `payload` on disk behind the same digest key with no change to any of the
 * arithmetic here. What it does not measure is stated plainly in `SCALE.md`.
 */
export class NetworkStore {
  readonly #chunking: ChunkingOptions | undefined;
  readonly #sketch: SketchOptions | undefined;
  readonly #query: QueryOptions | undefined;
  readonly #maxChainDepth: number;
  readonly #referenceCandidates: number;
  readonly #index: SimilarityIndex;
  readonly #records = new Map<string, ChunkRecord>();

  #ingestedBytes = 0;
  #storedBytes = 0;
  #chunkReferences = 0;
  #exactHits = 0;
  #deltaChunks = 0;
  #standaloneChunks = 0;
  #dedupOnlyBytes = 0;
  #maxObservedChainDepth = 0;
  #similarityQueries = 0;
  #similarityCandidatesExamined = 0;
  #verificationFallbacks = 0;

  constructor(options?: NetworkStoreOptions) {
    const maxChainDepth = options?.maxChainDepth ?? DEFAULT_MAX_CHAIN_DEPTH;
    const referenceCandidates = options?.referenceCandidates ?? DEFAULT_REFERENCE_CANDIDATES;
    if (!Number.isInteger(maxChainDepth) || maxChainDepth < 0) {
      throw new NetworkStoreError(
        `maxChainDepth must be a non-negative integer, received ${String(maxChainDepth)}`,
      );
    }
    if (!Number.isInteger(referenceCandidates) || referenceCandidates < 0) {
      throw new NetworkStoreError(
        `referenceCandidates must be a non-negative integer, received ${String(referenceCandidates)}`,
      );
    }
    this.#chunking = options?.chunking;
    this.#sketch = options?.sketch;
    this.#query = { ...DEFAULT_STORE_QUERY_OPTIONS, ...options?.query };
    this.#maxChainDepth = maxChainDepth;
    this.#referenceCandidates = referenceCandidates;

    this.#index = new SimilarityIndex(
      resolveStoreIndexOptions(options?.index, options?.sketch?.sketchSize),
    );
  }

  /**
   * Chunk, deduplicate, delta-code against the corpus, and store `bytes`.
   *
   * Per chunk, in order:
   *
   *  1. digest it. If that digest is already stored, this is an exact hit and adds **zero** bytes.
   *     No sketching, no query, no compression — the cheapest possible path, and the reason a
   *     re-upload of identical bytes is free.
   *  2. otherwise sketch it and ask the similarity index for reference candidates, skipping any
   *     whose chain is already at the depth bound.
   *  3. delta-encode against each candidate and keep the smallest raw delta as *the* reference.
   *  4. hand the chunk and that reference to `chooseEncoding`, which measures standalone brotli,
   *     measures and verifies the compressed delta, and returns whichever is genuinely smaller.
   *  5. insert the record, then resolve it straight back out of the store and byte-compare. On
   *     any mismatch, replace it with a standalone record and count a fallback.
   *  6. add the sketch to the index, so this chunk is a reference candidate for everything after
   *     it. This is the step that makes the corpus compound.
   *
   * @returns a receipt that reconstructs `bytes` exactly.
   */
  ingest(bytes: Uint8Array): IngestReceipt {
    const chunks = chunkBytes(bytes, this.#chunking);
    const chunkDigests: string[] = [];

    let exactHits = 0;
    let deltaChunks = 0;
    let standaloneChunks = 0;
    let newStoredBytes = 0;
    let dedupOnlyBytes = 0;

    for (const chunk of chunks) {
      // Materialized rather than a subarray view: every consumer below (hashing, sketching,
      // brotli, delta encoding) is correct on a view, but a record's payload must not alias the
      // caller's buffer, and one slice here removes the whole class of aliasing question.
      const plaintext = bytes.slice(chunk.offset, chunk.offset + chunk.length);
      const digest = digestChunkSync(plaintext);
      chunkDigests.push(digest);
      this.#chunkReferences += 1;

      if (this.#records.has(digest)) {
        exactHits += 1;
        this.#exactHits += 1;
        continue;
      }

      const sketch = sketchBytes(plaintext, this.#sketch);
      const reference = this.#selectReference(plaintext, sketch, digest);
      const choice = chooseEncoding(plaintext, reference === null ? null : reference.bytes);

      let record: ChunkRecord;
      if (choice.kind === 'delta' && reference !== null) {
        record = {
          digest,
          length: plaintext.length,
          kind: 'delta',
          payload: choice.bytes,
          referenceDigest: reference.digest,
          storedBytes: choice.bytes.length + REFERENCE_POINTER_BYTES,
          depth: reference.depth + 1,
          standaloneBaselineBytes: choice.sizes.standaloneCompressedBytes,
        };
      } else {
        record = {
          digest,
          length: plaintext.length,
          kind: 'standalone',
          payload: choice.bytes,
          referenceDigest: null,
          storedBytes: choice.bytes.length,
          depth: 0,
          standaloneBaselineBytes: choice.sizes.standaloneCompressedBytes,
        };
      }
      this.#records.set(digest, record);

      // The end-to-end proof, taken after insertion so it exercises the exact path a reader will
      // take, including the reference's own chain. `chooseEncoding` already verified the delta
      // against the reference bytes it was handed; this verifies that resolving the reference out
      // of the store reproduces those bytes too.
      if (!this.#verifyStored(record, plaintext)) {
        this.#verificationFallbacks += 1;
        const fallback = chooseEncoding(plaintext, null);
        record = {
          digest,
          length: plaintext.length,
          kind: 'standalone',
          payload: fallback.bytes,
          referenceDigest: null,
          storedBytes: fallback.bytes.length,
          depth: 0,
          standaloneBaselineBytes: fallback.sizes.standaloneCompressedBytes,
        };
        this.#records.set(digest, record);
        if (!this.#verifyStored(record, plaintext)) {
          // Standalone is brotli round-tripped through the same code that just produced it. If
          // that fails, the environment is not trustworthy and silently storing the chunk would
          // be worse than refusing it.
          throw new NetworkStoreError(
            `standalone record for ${digest} failed verification; refusing to store`,
          );
        }
      }

      if (record.kind === 'delta') {
        deltaChunks += 1;
        this.#deltaChunks += 1;
      } else {
        standaloneChunks += 1;
        this.#standaloneChunks += 1;
      }
      newStoredBytes += record.storedBytes;
      dedupOnlyBytes += record.standaloneBaselineBytes;
      this.#storedBytes += record.storedBytes;
      this.#dedupOnlyBytes += record.standaloneBaselineBytes;
      if (record.depth > this.#maxObservedChainDepth) {
        this.#maxObservedChainDepth = record.depth;
      }

      this.#index.add(digest, sketch);
    }

    this.#ingestedBytes += bytes.length;
    return {
      chunkDigests,
      totalBytes: bytes.length,
      exactHits,
      deltaChunks,
      standaloneChunks,
      newStoredBytes,
      dedupOnlyBytes,
    };
  }

  /**
   * Rebuild the exact bytes a receipt was issued for.
   *
   * Each chunk is resolved independently by walking its delta chain from the standalone record at
   * its root forward to the chunk itself. The output length is checked against the receipt, so a
   * receipt from a different store or a mutated one fails loudly instead of returning a plausible
   * wrong buffer.
   *
   * @throws {NetworkStoreError} if a chunk is missing, if a chain cycles or exceeds the bound, or
   * if the reassembled length disagrees with the receipt.
   */
  reconstruct(receipt: IngestReceipt): Uint8Array {
    const out = new Uint8Array(receipt.totalBytes);
    let offset = 0;
    for (const digest of receipt.chunkDigests) {
      const plaintext = this.resolveChunk(digest);
      if (offset + plaintext.length > out.length) {
        throw new NetworkStoreError(
          `receipt claims ${String(receipt.totalBytes)} bytes but its chunks produce more`,
        );
      }
      out.set(plaintext, offset);
      offset += plaintext.length;
    }
    if (offset !== receipt.totalBytes) {
      throw new NetworkStoreError(
        `receipt claims ${String(receipt.totalBytes)} bytes but its chunks produce ${String(offset)}`,
      );
    }
    return out;
  }

  /**
   * The plaintext of one stored chunk.
   *
   * Walks to the root of the delta chain collecting records, then decodes forward. The visited set
   * makes a cycle a thrown error rather than an infinite loop, and the length check makes an
   * over-long chain a thrown error rather than a slow read — both are unreachable given how
   * `ingest` builds records, and both are checked anyway because that costs a `Set` and turns an
   * argument into a guarantee.
   *
   * @throws {NetworkStoreError} on a missing record, a cycle, an over-long chain, or a chain whose
   * root is not standalone.
   */
  resolveChunk(digest: string): Uint8Array {
    const chain: ChunkRecord[] = [];
    const visited = new Set<string>();
    let cursor: string | null = digest;

    while (cursor !== null) {
      if (visited.has(cursor)) {
        throw new NetworkStoreError(`delta chain for ${digest} cycles at ${cursor}`);
      }
      visited.add(cursor);
      const record: ChunkRecord | undefined = this.#records.get(cursor);
      if (record === undefined) {
        throw new NetworkStoreError(`chunk ${cursor} is not stored (resolving ${digest})`);
      }
      chain.push(record);
      if (chain.length > this.#maxChainDepth + 1) {
        throw new NetworkStoreError(
          `delta chain for ${digest} exceeds the bound of ${String(this.#maxChainDepth)}`,
        );
      }
      cursor = record.referenceDigest;
    }

    const root = chain[chain.length - 1];
    if (root === undefined || root.kind !== 'standalone') {
      throw new NetworkStoreError(`delta chain for ${digest} does not terminate in a standalone`);
    }
    let plaintext = decodeStandalonePayload(root.payload);
    for (let index = chain.length - 2; index >= 0; index -= 1) {
      const step = chain[index] as ChunkRecord;
      plaintext = decodeDeltaPayload(plaintext, step.payload);
    }
    return plaintext;
  }

  /** Cumulative accounting. See {@link NetworkStoreStats} for what each field is measured from. */
  stats(): NetworkStoreStats {
    const manifestBytes = this.#chunkReferences * REFERENCE_POINTER_BYTES;
    return {
      ingestedBytes: this.#ingestedBytes,
      storedBytes: this.#storedBytes,
      chunks: this.#chunkReferences,
      exactHits: this.#exactHits,
      deltaChunks: this.#deltaChunks,
      standaloneChunks: this.#standaloneChunks,
      deltaBytesSaved: this.#dedupOnlyBytes - this.#storedBytes,
      effectiveRatio: this.#storedBytes === 0 ? 1 : this.#ingestedBytes / this.#storedBytes,
      uniqueChunks: this.#records.size,
      dedupOnlyBytes: this.#dedupOnlyBytes,
      manifestBytes,
      storedBytesWithManifest: this.#storedBytes + manifestBytes,
      maxObservedChainDepth: this.#maxObservedChainDepth,
      similarityQueries: this.#similarityQueries,
      similarityCandidatesExamined: this.#similarityCandidatesExamined,
      meanCandidatesPerQuery:
        this.#similarityQueries === 0
          ? 0
          : this.#similarityCandidatesExamined / this.#similarityQueries,
      indexSize: this.#index.size(),
      verificationFallbacks: this.#verificationFallbacks,
    };
  }

  has(digest: string): boolean {
    return this.#records.has(digest);
  }

  /** The stored record, so a test or a report can inspect a chain without decoding it. */
  recordFor(digest: string): ChunkRecord | undefined {
    return this.#records.get(digest);
  }

  /** Every stored digest, in insertion order. */
  digests(): string[] {
    return [...this.#records.keys()];
  }

  /** Chain depth histogram, `depthCounts[d]` records at depth `d`. Length is the bound plus one. */
  depthHistogram(): number[] {
    const counts = new Array<number>(this.#maxChainDepth + 1).fill(0);
    for (const record of this.#records.values()) {
      const slot = counts[record.depth];
      if (slot === undefined) {
        throw new NetworkStoreError(
          `record ${record.digest} has depth ${String(record.depth)} beyond the bound`,
        );
      }
      counts[record.depth] = slot + 1;
    }
    return counts;
  }

  get maxChainDepth(): number {
    return this.#maxChainDepth;
  }

  /** Read-only handle on the index, for reporting its own banding statistics. */
  get similarityIndex(): SimilarityIndex {
    return this.#index;
  }

  /**
   * The best reference for `plaintext`, or `null` if the corpus offers none worth trying.
   *
   * Candidates come from the banded index, are filtered to those whose chain has room, and are
   * then *actually delta-encoded*; the smallest raw delta wins, with the digest breaking ties so
   * the choice is fully determined by store contents and never by iteration order. Encoding
   * happens here rather than being left to `chooseEncoding` because choosing between candidates
   * requires measuring all of them, and raw delta size is the cheap measurement.
   */
  #selectReference(
    plaintext: Uint8Array,
    sketch: Sketch,
    selfDigest: string,
  ): ReferenceCandidate | null {
    if (this.#referenceCandidates === 0 || this.#maxChainDepth === 0) {
      return null;
    }
    const matches = this.#index.query(sketch, this.#query);
    this.#similarityQueries += 1;
    this.#similarityCandidatesExamined += this.#index.stats().lastQueryCandidatesExamined;

    let best: ReferenceCandidate | null = null;
    let tried = 0;
    for (const match of matches) {
      if (tried >= this.#referenceCandidates) {
        break;
      }
      if (match.digest === selfDigest) {
        continue;
      }
      const record = this.#records.get(match.digest);
      if (record === undefined || record.depth + 1 > this.#maxChainDepth) {
        continue;
      }
      const referenceBytes = this.resolveChunk(match.digest);
      tried += 1;
      const rawDeltaBytes = encodeDelta(referenceBytes, plaintext).length;
      if (
        best === null ||
        rawDeltaBytes < best.rawDeltaBytes ||
        (rawDeltaBytes === best.rawDeltaBytes && match.digest < best.digest)
      ) {
        best = {
          digest: match.digest,
          bytes: referenceBytes,
          depth: record.depth,
          jaccard: match.jaccard,
          rawDeltaBytes,
        };
      }
    }
    return best;
  }

  /** Resolves `record` out of the store and byte-compares it against the plaintext it encodes. */
  #verifyStored(record: ChunkRecord, plaintext: Uint8Array): boolean {
    try {
      return bytesEqual(this.resolveChunk(record.digest), plaintext);
    } catch {
      return false;
    }
  }
}
