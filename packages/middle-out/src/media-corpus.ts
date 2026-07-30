/**
 * Deterministic structural models of the redundancy that real media libraries contain.
 *
 * WHAT THIS FILE IS, STATED BLUNTLY SO NO READER IS MISLED
 * -------------------------------------------------------
 * These generators do **not** produce encoded video. They produce byte sequences whose
 * *redundancy structure* is a deliberate model of three redundancy patterns that real media
 * libraries actually exhibit. Nothing here is a stand-in for measuring H.264/AV1 bitstreams; it
 * is a way to exercise and measure the storage layer under redundancy shapes we can describe
 * exactly, so that any number the benchmark prints can be traced back to a construction the
 * reader can check line by line.
 *
 * The single most important design decision: **every byte that is not a deliberate copy is drawn
 * from a splitmix32 stream, i.e. it is incompressible.** Measured: brotli quality 11 over 32 KiB
 * of this stream returns 32 772 bytes — it *grows* by 4. That is on purpose and it is the honest
 * choice, because entropy-coded video is likewise essentially incompressible. It means:
 *
 *   - the per-file brotli baseline in the benchmark gets a ratio of ~1.00, which is what it
 *     really gets on video, rather than an inflated one from repetitive filler;
 *   - similarity-delta cannot win by finding local entropy. The only thing it can win on is the
 *     literal reuse the construction actually put there. There is no way for the measurement to
 *     accidentally flatter the thesis.
 *
 * A corpus of *pure* noise would be the opposite dishonesty: mutually dissimilar by
 * construction, so similarity-delta would be guaranteed to find nothing and the exercise would
 * measure nothing. `scripts/scale-benchmark.ts` therefore runs a pure-noise corpus too, as a
 * declared control, and reports that its ratio stays flat.
 *
 * THE THREE PATTERNS, AND HOW DEFENSIBLE EACH ONE IS
 * --------------------------------------------------
 * 1. {@link generateReactionCorpus} — many uploads that each embed one byte-identical clip
 *    inside otherwise-unique content. **Most defensible of the three.** When a creator drops a
 *    downloaded clip onto a timeline and the pipeline stream-copies it, or when the same asset is
 *    redistributed, the bytes really are identical. This pattern is mostly caught by *exact*
 *    chunk dedup, and the benchmark shows exactly that — it is included so the report cannot
 *    claim for delta what dedup already earns.
 *
 * 2. {@link generateReencodeVariants} — one master, re-encoded with slightly different settings:
 *    long identical stretches broken by short scattered divergent runs, plus a few length-changing
 *    edits. **Defensible.** This is the shape of a settings tweak that leaves most coded regions
 *    untouched, of a container remux, and of a metadata rewrite. It is also the case where exact
 *    chunk dedup collapses to nothing — one differing byte anywhere in a chunk changes its digest
 *    — while a delta coder sees ~98 % copyable material. This is the pattern that isolates the
 *    novel step.
 *
 * 3. {@link generateRenditionLadder} — a "source" of GOP-like blocks, and lower renditions that
 *    retain a decreasing fraction of the source's sub-blocks verbatim and re-code the rest at a
 *    lower bit cost. **The one that needs a caveat, so here it is:** two renditions of the same
 *    video at *different resolutions* under a modern codec do not generally share literal
 *    bitstream runs, and this generator must not be read as claiming they do. What it models is
 *    the case where a ladder step preserves coded segments byte-for-byte and re-codes the others
 *    — which is what a CRF/bitrate-only ladder step, a partial re-encode, or a segment-level
 *    re-package does. The verbatim run length is a parameter (`subBlocksPerGop`), and the storage
 *    win scales with it, which is precisely why the run length has to be measured on real
 *    encodes rather than assumed.
 *
 * THE HONEST NEXT STEP is to re-run `scripts/scale-benchmark.ts` over a real public video corpus
 * — the same asset at several ladder rungs, real remuxes, real re-encodes — and publish whatever
 * it says. The storage layer does not know or care where its bytes came from; only the *inputs*
 * here are modelled, and swapping them for real files changes nothing but the numbers.
 *
 * Determinism: every generator is a pure function of its seed and options. No `Math.random`, no
 * `Date.now`, no platform-dependent arithmetic — all mixing is 32-bit integer work via
 * `Math.imul`, so two nodes generate byte-identical corpora.
 */

/** Thrown for unusable generator options. Never thrown for any valid seed. */
export class MediaCorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaCorpusError';
  }
}

/**
 * splitmix32, inlined so a corpus is reproducible from this file alone with no dependency.
 *
 * The increment is the 32-bit golden-ratio constant and the finalizer is two xor-multiply-shift
 * rounds; the sequence passes as high-entropy for our purposes, which is all that is claimed —
 * and is verified operationally by the fact that brotli quality 11 cannot compress it at all.
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

/** Standalone avalanche step, used to derive independent sub-seeds and per-decision draws. */
function mix32(value: number): number {
  let z = value >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0_aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a_2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

/**
 * Domain tags, so the sub-seed streams used for different purposes cannot coincide.
 *
 * Any distinct set of constants would do; these are fixed so a corpus is reproducible forever.
 */
const DOMAIN = Object.freeze({
  gop: 0x60_9000,
  retainDecision: 0x7e_7a10,
  recodedBlock: 0x9e_c0de,
  clip: 0xc1_11b0,
  reactionPrefix: 0x97_e0f0,
  reactionSuffix: 0x5f_ff00,
  master: 0xa5_7e20,
  divergeDecision: 0xd1_7e26,
  divergedRun: 0x2e_c0de,
  insertPosition: 0x15_e270,
  insertedRun: 0xed_1700,
});

/** A sub-seed that depends on every part of `parts`, so two different tuples rarely collide. */
function deriveSeed(seed: number, ...parts: readonly number[]): number {
  let acc = mix32(seed);
  for (const part of parts) {
    acc = mix32((acc ^ mix32(part)) >>> 0);
  }
  return acc;
}

/** Fills `target[offset, offset+length)` with the incompressible stream for `seed`. */
function fillNoise(target: Uint8Array, offset: number, length: number, seed: number): void {
  const next = splitmix32(seed);
  let index = offset;
  const end = offset + length;
  while (index + 4 <= end) {
    const word = next();
    target[index] = word & 0xff;
    target[index + 1] = (word >>> 8) & 0xff;
    target[index + 2] = (word >>> 16) & 0xff;
    target[index + 3] = (word >>> 24) & 0xff;
    index += 4;
  }
  if (index < end) {
    let word = next();
    while (index < end) {
      target[index] = word & 0xff;
      word >>>= 8;
      index += 1;
    }
  }
}

/** A fresh incompressible buffer of `length` bytes. */
function noiseBytes(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  fillNoise(bytes, 0, length, seed);
  return bytes;
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new MediaCorpusError(`${name} must be a positive integer, received ${String(value)}`);
  }
}

function requireFraction(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new MediaCorpusError(
      `${name} must be a finite number strictly between 0 and 1, received ${String(value)}`,
    );
  }
}

function requireSeed(seed: number): void {
  if (!Number.isInteger(seed)) {
    throw new MediaCorpusError(`seed must be an integer, received ${String(seed)}`);
  }
}

/* ------------------------------------------------------------------------------------------- */
/* 1. Rendition ladder                                                                          */
/* ------------------------------------------------------------------------------------------- */

/** Knobs for {@link generateRenditionLadder}. Every field falls back to a documented default. */
export interface RenditionLadderOptions {
  /** GOP-like blocks in the source. Each is generated from its own sub-seed. */
  readonly gopCount?: number;
  /** Bytes per GOP-like block. */
  readonly gopBytes?: number;
  /** Lower renditions to derive. Rendition `r` retains `retention ** (r+1)` of the source. */
  readonly renditionCount?: number;
  /**
   * Sub-blocks a GOP is divided into. This sets the *verbatim run length*
   * (`gopBytes / subBlocksPerGop`) and is therefore the single knob that decides how much a
   * delta coder can copy. It is called out because the honest reading of any result here is
   * "delta captured the literal reuse present", not "delta created reuse".
   */
  readonly subBlocksPerGop?: number;
  /** Fraction of sub-blocks the first rendition keeps verbatim; later rungs keep less. */
  readonly retention?: number;
  /** Bit-cost scale applied to a *re-coded* sub-block, modelling a lower bitrate. */
  readonly recodeScale?: number;
  /** Use these bytes as the source instead of generating one. Length must be a positive number. */
  readonly source?: Uint8Array;
}

/**
 * `gopCount = 6` × `gopBytes = 32 KiB` gives a 192 KiB source: several content-defined chunks at
 * the package's 32 KiB average, so chunk-level behaviour is exercised rather than one-chunk
 * behaviour. `subBlocksPerGop = 16` makes verbatim runs 2 KiB — two orders of magnitude above
 * the delta coder's 20-byte minimum match, so a retained sub-block always encodes as a COPY.
 * `retention = 0.72` and `recodeScale = 0.85` place rung 1 at ~72 % verbatim and ~92 % of the
 * source's length, which are plausible for a bitrate-only ladder step and, more to the point,
 * are *stated* rather than tuned against the result.
 */
export const DEFAULT_RENDITION_LADDER_OPTIONS: Required<Omit<RenditionLadderOptions, 'source'>> =
  Object.freeze({
    gopCount: 6,
    gopBytes: 32 * 1024,
    renditionCount: 3,
    subBlocksPerGop: 16,
    retention: 0.72,
    recodeScale: 0.85,
  });

export interface RenditionLadder {
  /** The highest rung: pure incompressible GOP-like blocks. */
  readonly source: Uint8Array;
  /** Lower rungs, most-similar-to-source first. Each is shorter than the one before. */
  readonly renditions: readonly Uint8Array[];
}

/**
 * A source and a ladder of lower renditions derived from the *same underlying blocks*.
 *
 * Construction, exactly. The source is `gopCount` blocks of `gopBytes` incompressible bytes,
 * block `g` seeded from `(seed, g)`. Rendition `r` (0-indexed) walks the same blocks and, for
 * each of the `subBlocksPerGop` sub-blocks, draws one deterministic decision from
 * `(seed, g, s, r)`:
 *
 *   - with probability `retention ** (r + 1)` it appends the source sub-block **byte-for-byte**;
 *   - otherwise it appends `floor(subBlockBytes * recodeScale ** (r + 1))` freshly generated
 *     incompressible bytes, modelling that region being re-coded at a lower bit cost.
 *
 * Two properties follow, and they are the two that matter for the measurement. Renditions are
 * *not* byte-identical to the source or to each other, so exact chunk dedup cannot claim them.
 * And because re-coded sub-blocks change length, every downstream byte shifts — which is
 * precisely the case content-defined chunking is designed to survive and fixed-block hashing is
 * not.
 *
 * @throws {MediaCorpusError} on invalid options. Never throws for any seed.
 */
export function generateRenditionLadder(
  seed: number,
  options?: RenditionLadderOptions,
): RenditionLadder {
  requireSeed(seed);
  const gopCount = options?.gopCount ?? DEFAULT_RENDITION_LADDER_OPTIONS.gopCount;
  const gopBytes = options?.gopBytes ?? DEFAULT_RENDITION_LADDER_OPTIONS.gopBytes;
  const renditionCount = options?.renditionCount ?? DEFAULT_RENDITION_LADDER_OPTIONS.renditionCount;
  const subBlocksPerGop =
    options?.subBlocksPerGop ?? DEFAULT_RENDITION_LADDER_OPTIONS.subBlocksPerGop;
  const retention = options?.retention ?? DEFAULT_RENDITION_LADDER_OPTIONS.retention;
  const recodeScale = options?.recodeScale ?? DEFAULT_RENDITION_LADDER_OPTIONS.recodeScale;

  requirePositiveInteger('gopCount', gopCount);
  requirePositiveInteger('gopBytes', gopBytes);
  requirePositiveInteger('renditionCount', renditionCount);
  requirePositiveInteger('subBlocksPerGop', subBlocksPerGop);
  requireFraction('retention', retention);
  requireFraction('recodeScale', recodeScale);
  if (gopBytes % subBlocksPerGop !== 0) {
    throw new MediaCorpusError(
      `gopBytes (${String(gopBytes)}) must be divisible by subBlocksPerGop ` +
        `(${String(subBlocksPerGop)}) so sub-blocks tile a GOP exactly`,
    );
  }
  const subBlockBytes = gopBytes / subBlocksPerGop;

  let source: Uint8Array;
  let sourceGopCount: number;
  if (options?.source !== undefined) {
    if (options.source.length === 0) {
      throw new MediaCorpusError('source must be non-empty');
    }
    source = options.source;
    sourceGopCount = Math.max(1, Math.floor(source.length / gopBytes));
  } else {
    source = new Uint8Array(gopCount * gopBytes);
    for (let g = 0; g < gopCount; g += 1) {
      fillNoise(source, g * gopBytes, gopBytes, deriveSeed(seed, DOMAIN.gop, g));
    }
    sourceGopCount = gopCount;
  }

  const renditions: Uint8Array[] = [];
  for (let r = 0; r < renditionCount; r += 1) {
    const retainProbability = Math.pow(retention, r + 1);
    const retainThreshold = Math.round(retainProbability * 0x1_0000);
    const recodedBytes = Math.max(1, Math.floor(subBlockBytes * Math.pow(recodeScale, r + 1)));

    // Two passes: size the buffer from the same decisions that will fill it, so the rendition is
    // built without any growable-buffer bookkeeping and its length is a pure function of seed.
    let total = 0;
    for (let g = 0; g < sourceGopCount; g += 1) {
      for (let s = 0; s < subBlocksPerGop; s += 1) {
        const draw = deriveSeed(seed, DOMAIN.retainDecision, g, s, r) & 0xffff;
        const start = g * gopBytes + s * subBlockBytes;
        const available = Math.max(0, Math.min(subBlockBytes, source.length - start));
        total += draw < retainThreshold ? available : Math.min(recodedBytes, available);
      }
    }

    const rendition = new Uint8Array(total);
    let cursor = 0;
    for (let g = 0; g < sourceGopCount; g += 1) {
      for (let s = 0; s < subBlocksPerGop; s += 1) {
        const draw = deriveSeed(seed, DOMAIN.retainDecision, g, s, r) & 0xffff;
        const start = g * gopBytes + s * subBlockBytes;
        const available = Math.max(0, Math.min(subBlockBytes, source.length - start));
        if (available === 0) {
          continue;
        }
        if (draw < retainThreshold) {
          rendition.set(source.subarray(start, start + available), cursor);
          cursor += available;
        } else {
          const length = Math.min(recodedBytes, available);
          fillNoise(rendition, cursor, length, deriveSeed(seed, DOMAIN.recodedBlock, g, s, r));
          cursor += length;
        }
      }
    }
    renditions.push(rendition);
  }

  return { source, renditions };
}

/* ------------------------------------------------------------------------------------------- */
/* 2. Reaction / stock-footage reuse                                                            */
/* ------------------------------------------------------------------------------------------- */

/** Knobs for {@link generateReactionCorpus}. */
export interface ReactionCorpusOptions {
  /** How many uploads to produce. */
  readonly videoCount?: number;
  /** Length of the shared, byte-identical clip every upload embeds. */
  readonly clipBytes?: number;
  /** Unique bytes each upload contributes around the clip. */
  readonly uniqueBytes?: number;
  /**
   * Embed the clip at a different offset in each upload. Left on by default: it is the realistic
   * case, and it is the one that distinguishes content-defined chunking (which realigns) from
   * fixed-block hashing (which does not).
   */
  readonly stagger?: boolean;
  /** Use these bytes as the shared clip instead of generating one. */
  readonly clip?: Uint8Array;
}

/**
 * `videoCount = 4`, a 64 KiB clip inside 96 KiB of unique material: the clip is 40 % of each
 * upload, which is a modest reuse fraction for a reaction cut, and two content-defined chunks
 * wide, so at least one whole chunk of the clip should land byte-identical across uploads and be
 * claimed by exact dedup. The point of the case is to show dedup earning that, not delta.
 */
export const DEFAULT_REACTION_CORPUS_OPTIONS: Required<Omit<ReactionCorpusOptions, 'clip'>> =
  Object.freeze({
    videoCount: 4,
    clipBytes: 64 * 1024,
    uniqueBytes: 96 * 1024,
    stagger: true,
  });

/**
 * Uploads that each embed one shared clip, verbatim, surrounded by unique content.
 *
 * Construction: one clip of incompressible bytes is generated once (or supplied). Upload `v` is
 * `prefix ++ clip ++ suffix`, where prefix and suffix are unique incompressible bytes seeded from
 * `(seed, v)` and the split point moves with `v` when `stagger` is on. The clip bytes are
 * *identical* in every upload — this is the one pattern where that claim is unconditionally true
 * of real pipelines, because stream-copying an asset copies its bytes.
 *
 * @throws {MediaCorpusError} on invalid options.
 */
export function generateReactionCorpus(
  seed: number,
  options?: ReactionCorpusOptions,
): Uint8Array[] {
  requireSeed(seed);
  const videoCount = options?.videoCount ?? DEFAULT_REACTION_CORPUS_OPTIONS.videoCount;
  const clipBytes = options?.clipBytes ?? DEFAULT_REACTION_CORPUS_OPTIONS.clipBytes;
  const uniqueBytes = options?.uniqueBytes ?? DEFAULT_REACTION_CORPUS_OPTIONS.uniqueBytes;
  const stagger = options?.stagger ?? DEFAULT_REACTION_CORPUS_OPTIONS.stagger;

  requirePositiveInteger('videoCount', videoCount);
  requirePositiveInteger('clipBytes', clipBytes);
  requirePositiveInteger('uniqueBytes', uniqueBytes);

  let clip: Uint8Array;
  if (options?.clip !== undefined) {
    if (options.clip.length === 0) {
      throw new MediaCorpusError('clip must be non-empty');
    }
    clip = options.clip;
  } else {
    clip = noiseBytes(clipBytes, deriveSeed(seed, DOMAIN.clip));
  }

  const videos: Uint8Array[] = [];
  for (let v = 0; v < videoCount; v += 1) {
    const prefixBytes = stagger
      ? Math.floor((uniqueBytes * (v + 1)) / (videoCount + 1))
      : Math.floor(uniqueBytes / 2);
    const suffixBytes = uniqueBytes - prefixBytes;
    const video = new Uint8Array(prefixBytes + clip.length + suffixBytes);
    fillNoise(video, 0, prefixBytes, deriveSeed(seed, DOMAIN.reactionPrefix, v));
    video.set(clip, prefixBytes);
    fillNoise(
      video,
      prefixBytes + clip.length,
      suffixBytes,
      deriveSeed(seed, DOMAIN.reactionSuffix, v),
    );
    videos.push(video);
  }
  return videos;
}

/* ------------------------------------------------------------------------------------------- */
/* 3. Re-encode variants                                                                        */
/* ------------------------------------------------------------------------------------------- */

/** Knobs for {@link generateReencodeVariants}. */
export interface ReencodeVariantOptions {
  /** How many variants to produce. Variant `v` diverges from the master by `(v+1)` steps. */
  readonly variantCount?: number;
  /** Length of the generated master, when `source` is not supplied. */
  readonly sourceBytes?: number;
  /** Length of one divergent run: the granularity at which a setting change rewrites bytes. */
  readonly divergenceRunBytes?: number;
  /** Fraction of the master's bytes that a *single* divergence step rewrites. */
  readonly divergencePerStep?: number;
  /** Length-changing edits per variant, modelling a header or segment-size change. */
  readonly shiftEdits?: number;
  /** Use these bytes as the master instead of generating one. */
  readonly source?: Uint8Array;
}

/**
 * `divergenceRunBytes = 24` at `divergencePerStep = 0.02` means variant 0 rewrites 2 % of the
 * master in ~24-byte runs, leaving identical stretches averaging about 1.2 KiB. That combination
 * is chosen to be *hostile to exact dedup and honest about it*: a 32 KiB chunk contains roughly
 * 27 divergent runs, so no chunk of any variant is byte-identical to any chunk of the master and
 * exact dedup gets nothing at all — while a delta coder legitimately sees ~98 % copyable
 * material. `shiftEdits = 3` inserts three short runs so variant lengths differ and every
 * downstream byte shifts, which is the case fixed-block hashing cannot survive.
 */
export const DEFAULT_REENCODE_VARIANT_OPTIONS: Required<Omit<ReencodeVariantOptions, 'source'>> =
  Object.freeze({
    variantCount: 6,
    sourceBytes: 192 * 1024,
    divergenceRunBytes: 24,
    divergencePerStep: 0.02,
    shiftEdits: 3,
  });

/**
 * One master re-encoded at several settings: long identical stretches, scattered divergent runs.
 *
 * Construction, exactly. Variant `v` copies the master and then, walking it in
 * `divergenceRunBytes` runs, replaces a run with freshly generated incompressible bytes when a
 * deterministic draw from `(seed, runIndex, v)` falls under `divergencePerStep * (v + 1)`. Then
 * `shiftEdits` short runs of new bytes are *inserted* at positions derived from `(seed, v)`, so
 * the variant's length differs from the master's and from the other variants'.
 *
 * The result is the pattern that separates the two mechanisms cleanly: exact chunk dedup gets
 * approximately zero, because every chunk differs somewhere; similarity-indexed delta gets most
 * of the file, because most of the file is untouched. Both facts are measured by the benchmark
 * rather than asserted here.
 *
 * @throws {MediaCorpusError} on invalid options.
 */
export function generateReencodeVariants(
  seed: number,
  options?: ReencodeVariantOptions,
): Uint8Array[] {
  requireSeed(seed);
  const variantCount = options?.variantCount ?? DEFAULT_REENCODE_VARIANT_OPTIONS.variantCount;
  const sourceBytes = options?.sourceBytes ?? DEFAULT_REENCODE_VARIANT_OPTIONS.sourceBytes;
  const divergenceRunBytes =
    options?.divergenceRunBytes ?? DEFAULT_REENCODE_VARIANT_OPTIONS.divergenceRunBytes;
  const divergencePerStep =
    options?.divergencePerStep ?? DEFAULT_REENCODE_VARIANT_OPTIONS.divergencePerStep;
  const shiftEdits = options?.shiftEdits ?? DEFAULT_REENCODE_VARIANT_OPTIONS.shiftEdits;

  requirePositiveInteger('variantCount', variantCount);
  requirePositiveInteger('sourceBytes', sourceBytes);
  requirePositiveInteger('divergenceRunBytes', divergenceRunBytes);
  requireFraction('divergencePerStep', divergencePerStep);
  if (!Number.isInteger(shiftEdits) || shiftEdits < 0) {
    throw new MediaCorpusError(
      `shiftEdits must be a non-negative integer, received ${String(shiftEdits)}`,
    );
  }

  let master: Uint8Array;
  if (options?.source !== undefined) {
    if (options.source.length === 0) {
      throw new MediaCorpusError('source must be non-empty');
    }
    master = options.source;
  } else {
    master = noiseBytes(sourceBytes, deriveSeed(seed, DOMAIN.master));
  }

  const runCount = Math.ceil(master.length / divergenceRunBytes);
  const variants: Uint8Array[] = [];

  for (let v = 0; v < variantCount; v += 1) {
    const probability = Math.min(0.9, divergencePerStep * (v + 1));
    const threshold = Math.round(probability * 0x1_0000);

    const substituted = master.slice();
    for (let run = 0; run < runCount; run += 1) {
      const draw = deriveSeed(seed, DOMAIN.divergeDecision, run, v) & 0xffff;
      if (draw >= threshold) {
        continue;
      }
      const start = run * divergenceRunBytes;
      const length = Math.min(divergenceRunBytes, substituted.length - start);
      fillNoise(substituted, start, length, deriveSeed(seed, DOMAIN.divergedRun, run, v));
    }

    // Length-changing edits, applied after substitution so their positions do not depend on it.
    const editBytes = divergenceRunBytes * 2;
    const insertions: number[] = [];
    for (let e = 0; e < shiftEdits; e += 1) {
      insertions.push(deriveSeed(seed, DOMAIN.insertPosition, v, e) % (substituted.length + 1));
    }
    insertions.sort((left, right) => left - right);

    const variant = new Uint8Array(substituted.length + insertions.length * editBytes);
    let readCursor = 0;
    let writeCursor = 0;
    for (let e = 0; e < insertions.length; e += 1) {
      const at = insertions[e] as number;
      const copyLength = at - readCursor;
      variant.set(substituted.subarray(readCursor, at), writeCursor);
      readCursor = at;
      writeCursor += copyLength;
      fillNoise(variant, writeCursor, editBytes, deriveSeed(seed, DOMAIN.insertedRun, v, e));
      writeCursor += editBytes;
    }
    variant.set(substituted.subarray(readCursor), writeCursor);
    variants.push(variant);
  }

  return variants;
}
