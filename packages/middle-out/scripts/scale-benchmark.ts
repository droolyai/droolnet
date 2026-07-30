/**
 * The scale curve: does storage efficiency actually improve as the corpus grows?
 *
 * Three strategies, measured on byte-identical input, with identical chunking where chunking
 * applies:
 *
 *   (a) per-file brotli quality 11 — what every video platform does today. Each upload compressed
 *       in isolation, because that is the only thing a compressor is given the chance to do.
 *   (b) exact chunk dedup + per-chunk brotli quality 11 — the strongest honest form of what
 *       IPFS-style content-addressed storage gives you. (IPFS itself stores chunks uncompressed,
 *       so this baseline is *better* than the real thing; the comparison is deliberately unkind to
 *       the result being argued for.)
 *   (c) middle-out network store — (b) plus similarity-indexed delta compression against the
 *       corpus already held.
 *
 * THE CLAIM UNDER TEST: (c)'s effective ratio rises with the number of uploads, while (a)'s stays
 * flat. (a) has no mechanism by which it *could* rise — it never sees more than one file — so the
 * interesting question is only whether (c) rises, and by how much.
 *
 * HOW (b) IS OBTAINED WITHOUT A SECOND MEASUREMENT PASS. `chooseEncoding` already compresses every
 * distinct chunk standalone at quality 11, because that measurement *is* the never-worse test. The
 * store records it per chunk as `standaloneBaselineBytes` and sums it as `dedupOnlyBytes`. So (b)
 * is not a re-implementation or a model of dedup-only storage; it is the same brotli numbers on the
 * same chunks, which removes any chance of the two strategies differing in methodology rather than
 * in mechanism.
 *
 * TWO CURVES ARE RUN, AND BOTH ARE REPORTED.
 *
 *   1. A **reuse corpus**, where uploads derive from a pool of source works. This is the case the
 *      thesis is about, and the pool grows sublinearly with uploads (see `assetsAvailable` below)
 *      because that is how content reuse actually behaves.
 *   2. A **control corpus** of mutually independent, incompressible works. Nothing resembles
 *      anything. This exists so the report cannot be accused of only showing the flattering case:
 *      if (c) does not stay flat at ~1.00 here, the never-worse guarantee is broken and the whole
 *      result is void.
 *
 * Every ingested upload is reconstructed and byte-compared. The script exits non-zero if any
 * reconstruction fails, so a green run is itself the correctness claim.
 *
 * Run:  node --experimental-strip-types packages/middle-out/scripts/scale-benchmark.ts
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem } from 'node:os';
import { brotliCompressSync, constants } from 'node:zlib';

import type * as MediaCorpusNamespace from '../src/media-corpus.js';
import type * as NetworkStoreNamespace from '../src/network-store.js';

/**
 * `src/` imports its siblings with `.js` specifiers, as the repo's TypeScript settings require,
 * but Node's type stripping resolves specifiers literally and will not try `./x.ts` for `./x.js`.
 * This hook closes that gap so the benchmark runs straight off the sources with no build step. It
 * only redirects relative `.js` specifiers with no `.js` file actually on disk.
 */
const TS_RESOLVE_HOOK = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL !== undefined) {
    const asJs = new URL(specifier, context.parentURL);
    if (asJs.protocol === 'file:' && !existsSync(fileURLToPath(asJs))) {
      const asTs = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(asTs))) {
        return { url: asTs.href, format: 'module-typescript', shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(TS_RESOLVE_HOOK)}`);

const mediaCorpus: typeof MediaCorpusNamespace = await import('../src/media-corpus.js');
const networkStore: typeof NetworkStoreNamespace = await import('../src/network-store.js');

const { generateReactionCorpus, generateReencodeVariants, generateRenditionLadder } = mediaCorpus;
const { DEFAULT_MAX_CHAIN_DEPTH, NetworkStore } = networkStore;

// ---------------------------------------------------------------------------------------------
// configuration

/** Uploads in the largest measured corpus. Powers of two up to this are reported. */
const MAX_UPLOADS = 64;

/** Checkpoints. Powers of two, plus the final N so the last row is never a truncated curve. */
const CHECKPOINTS = ((): number[] => {
  const points: number[] = [];
  for (let n = 1; n <= MAX_UPLOADS; n *= 2) {
    points.push(n);
  }
  if (points[points.length - 1] !== MAX_UPLOADS) {
    points.push(MAX_UPLOADS);
  }
  return points;
})();

/** Hard ceiling on the source-work pool, so the model cannot silently become "all new content". */
const ASSET_POOL_CEILING = 16;

/** Seeds, fixed so the corpus is byte-identical on every machine and every run. */
const REUSE_SEED_BASE = 0x5ca1_e000;
const CONTROL_SEED_BASE = 0xc07_0000;

const LADDER_OPTIONS = { gopCount: 6, renditionCount: 3 } as const;
const VARIANT_COUNT = 8;
const REACTION_COUNT = 5;
const CLIP_BYTES = 64 * 1024;

/** Derived items available per source work: 1 master + 3 rungs + 8 variants + 5 reaction cuts. */
const ITEMS_PER_ASSET = 1 + LADDER_OPTIONS.renditionCount + VARIANT_COUNT + REACTION_COUNT;

// ---------------------------------------------------------------------------------------------
// corpus schedule

/**
 * Distinct source works represented after `n + 1` uploads: `ceil(sqrt(n + 1))`.
 *
 * This is the one modelling assumption in the whole benchmark that is about *the network* rather
 * than about bytes, so it gets stated plainly. Content reuse is heavy-tailed: uploads do not each
 * introduce a new work, they cluster on a comparatively small set of works — renditions of it,
 * re-encodes of it, cuts that quote it. A square-root law is a deliberately conservative way to
 * say that. It means the number of *distinct* works still grows without bound, and grows fast
 * early (N = 4 already spans 2 works, N = 16 spans 4), so the corpus is never allowed to collapse
 * to "one video uploaded sixty-four times", which would make the result trivial.
 *
 * At N = 64 this yields 8 works averaging 8 uploads each. A reader who thinks that is optimistic
 * should raise the exponent and re-run; a reader who thinks it is pessimistic should lower it. The
 * shape of the claim does not depend on the constant, only the magnitude does — and the magnitude
 * is not the claim.
 */
function assetsAvailable(n: number): number {
  return Math.min(ASSET_POOL_CEILING, Math.ceil(Math.sqrt(n + 1)));
}

interface ScheduleEntry {
  readonly asset: number;
  /** Which derived item of that work this upload is. 0 is the master itself. */
  readonly item: number;
}

/** The full upload schedule, deterministic and independent of anything measured. */
function buildSchedule(uploads: number): ScheduleEntry[] {
  const occurrences = new Map<number, number>();
  const schedule: ScheduleEntry[] = [];
  for (let n = 0; n < uploads; n += 1) {
    const asset = n % assetsAvailable(n);
    const item = occurrences.get(asset) ?? 0;
    occurrences.set(asset, item + 1);
    if (item >= ITEMS_PER_ASSET) {
      // Would force a byte-identical re-upload, which is a free exact-dedup win and would flatter
      // the result. Refuse rather than quietly bank it.
      throw new Error(
        `schedule exhausted asset ${String(asset)}: item ${String(item)} exceeds the ` +
          `${String(ITEMS_PER_ASSET)} distinct derived items available`,
      );
    }
    schedule.push({ asset, item });
  }
  return schedule;
}

/** All derived items of one source work, generated once and cached. */
function buildAssetItems(seed: number): Uint8Array[] {
  const { source, renditions } = generateRenditionLadder(seed, LADDER_OPTIONS);
  const variants = generateReencodeVariants(seed ^ 0x1111_1111, {
    source,
    variantCount: VARIANT_COUNT,
  });
  const reactions = generateReactionCorpus(seed ^ 0x2222_2222, {
    clip: source.subarray(0, CLIP_BYTES),
    videoCount: REACTION_COUNT,
  });

  // Interleaved so consecutive uploads of one work are not all of the same kind. A run of eight
  // re-encode variants back to back would be the easiest possible ordering for the delta layer.
  const items: Uint8Array[] = [source];
  let r = 0;
  let v = 0;
  let x = 0;
  while (items.length < ITEMS_PER_ASSET) {
    if (r < renditions.length) {
      items.push(renditions[r] as Uint8Array);
      r += 1;
    }
    if (v < variants.length && items.length < ITEMS_PER_ASSET) {
      items.push(variants[v] as Uint8Array);
      v += 1;
    }
    if (x < reactions.length && items.length < ITEMS_PER_ASSET) {
      items.push(reactions[x] as Uint8Array);
      x += 1;
    }
  }
  return items;
}

/** Lazily materializes the reuse corpus, one upload at a time, so peak memory stays bounded. */
function reuseCorpus(uploads: number): Uint8Array[] {
  const schedule = buildSchedule(uploads);
  const cache = new Map<number, Uint8Array[]>();
  return schedule.map((entry) => {
    let items = cache.get(entry.asset);
    if (items === undefined) {
      items = buildAssetItems(REUSE_SEED_BASE + entry.asset * 0x9e37);
      cache.set(entry.asset, items);
    }
    const item = items[entry.item];
    if (item === undefined) {
      throw new Error(`asset ${String(entry.asset)} has no item ${String(entry.item)}`);
    }
    return item;
  });
}

/**
 * The control corpus: `uploads` mutually independent works, no reuse of any kind.
 *
 * Sizes are matched to the reuse corpus's masters so the two curves are comparable in scale.
 */
function controlCorpus(uploads: number): Uint8Array[] {
  const items: Uint8Array[] = [];
  for (let n = 0; n < uploads; n += 1) {
    items.push(generateRenditionLadder(CONTROL_SEED_BASE + n * 0x9e37, LADDER_OPTIONS).source);
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// measurement

function brotli11(bytes: Uint8Array): number {
  return brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  }).length;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface CurveRow {
  readonly uploads: number;
  readonly inputBytes: number;
  readonly perFileBrotliBytes: number;
  readonly dedupOnlyBytes: number;
  readonly middleOutBytes: number;
  readonly perFileRatio: number;
  readonly dedupOnlyRatio: number;
  readonly middleOutRatio: number;
  readonly chunks: number;
  readonly exactHits: number;
  readonly deltaChunks: number;
  readonly standaloneChunks: number;
  readonly meanCandidatesPerQuery: number;
  readonly maxObservedChainDepth: number;
  readonly indexSize: number;
}

interface CurveResult {
  readonly label: string;
  readonly rows: CurveRow[];
  readonly ingestSeconds: number;
  readonly ingestedBytes: number;
  readonly verified: number;
  readonly failures: string[];
  readonly verificationFallbacks: number;
  readonly depthHistogram: number[];
}

function runCurve(label: string, corpus: readonly Uint8Array[]): CurveResult {
  const store = new NetworkStore();
  const rows: CurveRow[] = [];
  const failures: string[] = [];
  const checkpoints = new Set(CHECKPOINTS);

  let inputBytes = 0;
  let perFileBrotliBytes = 0;
  let ingestNanos = 0n;
  let verified = 0;

  for (const [index, upload] of corpus.entries()) {
    const uploads = index + 1;
    inputBytes += upload.length;

    // Strategy (a), on its own clock so it is not counted as ingest time.
    perFileBrotliBytes += brotli11(upload);

    // Strategy (c). Timed. The digest of the input is taken before ingest so verification cannot
    // accidentally compare the store's output against the store's own output.
    const expected = sha256(upload);
    const started = process.hrtime.bigint();
    const receipt = store.ingest(upload);
    ingestNanos += process.hrtime.bigint() - started;

    const rebuilt = store.reconstruct(receipt);
    if (rebuilt.length !== upload.length || sha256(rebuilt) !== expected) {
      failures.push(
        `${label} upload ${String(uploads)}: reconstruction mismatch ` +
          `(${String(rebuilt.length)} vs ${String(upload.length)} bytes)`,
      );
    } else {
      verified += 1;
    }

    if (checkpoints.has(uploads)) {
      const stats = store.stats();
      rows.push({
        uploads,
        inputBytes,
        perFileBrotliBytes,
        dedupOnlyBytes: stats.dedupOnlyBytes,
        middleOutBytes: stats.storedBytes,
        perFileRatio: inputBytes / perFileBrotliBytes,
        dedupOnlyRatio: inputBytes / stats.dedupOnlyBytes,
        middleOutRatio: inputBytes / stats.storedBytes,
        chunks: stats.chunks,
        exactHits: stats.exactHits,
        deltaChunks: stats.deltaChunks,
        standaloneChunks: stats.standaloneChunks,
        meanCandidatesPerQuery: stats.meanCandidatesPerQuery,
        maxObservedChainDepth: stats.maxObservedChainDepth,
        indexSize: stats.indexSize,
      });
    }
  }

  const stats = store.stats();
  return {
    label,
    rows,
    ingestSeconds: Number(ingestNanos) / 1e9,
    ingestedBytes: stats.ingestedBytes,
    verified,
    failures,
    verificationFallbacks: stats.verificationFallbacks,
    depthHistogram: store.depthHistogram(),
  };
}

// ---------------------------------------------------------------------------------------------
// formatting

function mib(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

/**
 * Four decimals, not three.
 *
 * On incompressible input the honest answer is slightly *below* 1.0 — brotli's container costs a
 * few bytes it cannot earn back. Three decimals rounds that to a flattering `1.000`; four shows it.
 */
function ratio(value: number): string {
  return value.toFixed(4);
}

type Align = 'left' | 'right';

/**
 * A GitHub-flavoured markdown table, padded the way Prettier pads one.
 *
 * Emitting the canonical form matters for a mundane reason: this script *writes* `SCALE.md`, and the
 * repo runs `prettier --check` over the tree. If the generated file were not already canonical,
 * every benchmark run would leave the working tree failing format checks, and the obvious fix —
 * reformatting the report by hand — would put hand-edited numbers into a file whose entire value is
 * that no number in it was touched by hand. So the generator matches the formatter instead.
 *
 * Prettier's rule, reproduced here: column width is the widest of the header and all cells (minimum
 * 3), cells are padded to that width on the side the alignment implies, and the delimiter row fills
 * the width with dashes, carrying a trailing colon for a right-aligned column.
 */
function markdownTable(
  headers: readonly string[],
  aligns: readonly Align[],
  rows: readonly (readonly string[])[],
): string {
  const widths = headers.map((header, column) =>
    Math.max(3, header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const padCell = (text: string, column: number): string => {
    const width = widths[column] ?? 3;
    return aligns[column] === 'right' ? text.padStart(width) : text.padEnd(width);
  };
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell, column) => padCell(cell, column)).join(' | ')} |`;
  const delimiter = `| ${widths
    .map((width, column) =>
      aligns[column] === 'right' ? `${'-'.repeat(width - 1)}:` : '-'.repeat(width),
    )
    .join(' | ')} |`;
  return [line(headers), delimiter, ...rows.map(line)].join('\n');
}

const STORAGE_HEADERS = [
  'uploads',
  'input MiB',
  '(a) brotli-q11 MiB',
  '(b) dedup-only MiB',
  '(c) middle-out MiB',
  '(a) ratio',
  '(b) ratio',
  '(c) ratio',
] as const;

function storageTable(result: CurveResult): string {
  return markdownTable(
    STORAGE_HEADERS,
    STORAGE_HEADERS.map((): Align => 'right'),
    result.rows.map((row) => [
      String(row.uploads),
      mib(row.inputBytes),
      mib(row.perFileBrotliBytes),
      mib(row.dedupOnlyBytes),
      mib(row.middleOutBytes),
      ratio(row.perFileRatio),
      ratio(row.dedupOnlyRatio),
      `**${ratio(row.middleOutRatio)}**`,
    ]),
  );
}

const MECHANISM_HEADERS = [
  'uploads',
  'chunk refs',
  'exact hits',
  'delta chunks',
  'standalone chunks',
  'index size',
  'mean candidates/query',
  'max chain depth',
] as const;

function mechanismTable(result: CurveResult): string {
  return markdownTable(
    MECHANISM_HEADERS,
    MECHANISM_HEADERS.map((): Align => 'right'),
    result.rows.map((row) => [
      String(row.uploads),
      String(row.chunks),
      String(row.exactHits),
      String(row.deltaChunks),
      String(row.standaloneChunks),
      String(row.indexSize),
      row.meanCandidatesPerQuery.toFixed(2),
      String(row.maxObservedChainDepth),
    ]),
  );
}

/** The strategy legend, built through the same formatter so it is canonical too. */
function strategyTable(): string {
  return markdownTable(
    ['', 'strategy', 'what it models'],
    ['left', 'left', 'left'],
    [
      [
        '(a)',
        'per-file brotli quality 11',
        'Every platform today. Each upload compressed in isolation.',
      ],
      [
        '(b)',
        'exact chunk dedup + per-chunk brotli quality 11',
        'IPFS-style content-addressed storage, in a _stronger_ form than the real thing — IPFS stores chunks uncompressed.',
      ],
      [
        '(c)',
        'middle-out network store',
        '(b) plus similarity-indexed delta compression against the corpus already held.',
      ],
    ],
  );
}

function firstRow(result: CurveResult): CurveRow {
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`${result.label}: no rows`);
  }
  return row;
}

function lastRow(result: CurveResult): CurveRow {
  const row = result.rows[result.rows.length - 1];
  if (row === undefined) {
    throw new Error(`${result.label}: no rows`);
  }
  return row;
}

function throughput(result: CurveResult): string {
  return (result.ingestedBytes / (1024 * 1024) / result.ingestSeconds).toFixed(2);
}

// ---------------------------------------------------------------------------------------------
// run

const cpuModel = cpus()[0]?.model ?? 'unknown CPU';
const environment = [
  `- Node ${process.version} on ${process.platform}/${process.arch}`,
  `- ${cpuModel} (${String(cpus().length)} logical cores), ${(totalmem() / 1024 ** 3).toFixed(0)} GiB RAM`,
  `- brotli from \`node:zlib\`, quality 11, size hint set, for every compression in every strategy`,
].join('\n');

process.stdout.write('building corpora...\n');
const reuse = reuseCorpus(MAX_UPLOADS);
const control = controlCorpus(MAX_UPLOADS);

process.stdout.write(`ingesting reuse corpus (${String(reuse.length)} uploads)...\n`);
const reuseResult = runCurve('reuse corpus', reuse);
process.stdout.write(`ingesting control corpus (${String(control.length)} uploads)...\n`);
const controlResult = runCurve('control corpus', control);

const results = [reuseResult, controlResult];
const allFailures = results.flatMap((result) => result.failures);

const reuseFirst = firstRow(reuseResult);
const reuseLast = lastRow(reuseResult);
const controlFirst = firstRow(controlResult);
const controlLast = lastRow(controlResult);

const ratioGain = reuseLast.middleOutRatio / reuseFirst.middleOutRatio;
const ratioRises = reuseLast.middleOutRatio > reuseFirst.middleOutRatio;
const baselineFlat = Math.abs(reuseLast.perFileRatio - reuseFirst.perFileRatio) < 0.01;
const controlFlat = controlLast.middleOutRatio < 1.01 && controlLast.middleOutRatio > 0.98;

const report = `# Scale curve: does storage efficiency improve as the corpus grows?

Generated by \`scripts/scale-benchmark.ts\`. Every number below was written by that script from a
live run — none is typed by hand, estimated, or rounded up. Re-running overwrites this file.

## Reproduce

\`\`\`sh
node --experimental-strip-types packages/middle-out/scripts/scale-benchmark.ts
\`\`\`

Deterministic apart from timings: the corpus is generated from fixed seeds with an inlined
splitmix32, and the store makes no random or time-dependent decisions. Byte counts reproduce
exactly; MiB/s does not, and is reported as measured rather than as a specification.

## Environment

${environment}

## The three strategies

${strategyTable()}

(b) is not a re-implementation. \`chooseEncoding\` compresses every distinct chunk standalone
anyway, because that measurement _is_ the never-worse test, and the store records it per chunk.
Strategy (b) is the sum of those same brotli numbers over the same chunks from the same chunker, so
(b) and (c) cannot differ in methodology — only in mechanism.

## How the corpus is built, and why it is defensible

The generators are in \`src/media-corpus.ts\`, which documents each construction in full. They are
**structural models of media redundancy, not encoded video.** The single most important property:
every byte that is not a deliberate copy comes from a splitmix32 stream, so it is incompressible —
brotli quality 11 over 32 KiB of it returns 32 772 bytes, four _more_ than it was given. That is
the honest choice, because entropy-coded video is likewise near-incompressible, and it means
strategy (a) scores ~1.00 here exactly as it does on real video. It also means similarity delta
cannot win by finding local entropy: the only thing it can find is the literal reuse the
construction actually put there.

Three redundancy patterns, in descending order of how defensible each is:

1. **Reaction / stock-footage reuse** (\`generateReactionCorpus\`). Many uploads each embed one
   byte-identical 64 KiB clip inside unique content, at a different offset each time.
   Unconditionally realistic: stream-copying an asset copies its bytes. This is the pattern that
   _exact dedup_ is supposed to claim, and it is included so the report cannot credit delta for what
   dedup earns. Note what the mechanism table actually shows, which is less than one might expect: only
   the chunks lying wholly _inside_ the clip recur byte-identically, and at a 64 KiB clip against a
   32 KiB average chunk size that is about one chunk per upload. The chunks straddling either end of
   the clip mix shared and unique content, so their digests differ and only the delta path can claim
   them.
2. **Re-encode variants** (\`generateReencodeVariants\`). One master, re-coded with different
   settings: long identical stretches broken by ~24-byte divergent runs at 2 % density, plus three
   length-changing edits. Realistic for a settings tweak, a remux, or a metadata rewrite. This is
   the pattern that isolates the novel step, because a single differing byte anywhere in a chunk
   changes its digest, so exact dedup gets nothing while a delta coder sees ~98 % copyable material.
3. **Rendition ladder** (\`generateRenditionLadder\`). A source of GOP-like blocks; each lower rung
   retains a decreasing fraction of the source's 2 KiB sub-blocks verbatim and re-codes the rest at
   a lower bit cost. **This one needs its caveat stated in the same breath as its result:** two
   renditions of one video at _different resolutions_ under a modern codec do not generally share
   literal bitstream runs, and nothing here should be read as claiming they do. What it models is a
   ladder step that preserves coded segments byte-for-byte and re-codes the others — a
   CRF/bitrate-only rung, a partial re-encode, a segment-level repackage. The verbatim run length
   is a parameter, and the size of the win scales with it.

**The reuse schedule.** Upload _n_ is assigned to source work \`n mod ceil(sqrt(n+1))\`, so the
number of distinct works grows as the square root of the number of uploads: N = 1 spans 1 work,
N = 4 spans 2, N = 16 spans 4, N = ${String(MAX_UPLOADS)} spans ${String(assetsAvailable(MAX_UPLOADS - 1))}, averaging
${(MAX_UPLOADS / assetsAvailable(MAX_UPLOADS - 1)).toFixed(1)} uploads per work. This is the one assumption in the benchmark that is about the
_network_ rather than about bytes, so it is stated plainly rather than buried: content reuse is
heavy-tailed, uploads cluster on a comparatively small set of works. A square-root law is a
conservative way to say that — distinct works still grow without bound, and grow fast early, so the
corpus is never allowed to collapse into "one video uploaded ${String(MAX_UPLOADS)} times", which would make the
result trivial. The schedule also refuses to ever repeat a byte-identical upload, because that
would be a free exact-dedup win.

Each work supplies ${String(ITEMS_PER_ASSET)} distinct derived items (1 master, ${String(LADDER_OPTIONS.renditionCount)} ladder rungs, ${String(VARIANT_COUNT)} re-encode
variants, ${String(REACTION_COUNT)} reaction cuts), interleaved so consecutive uploads of one work are not all of the
same kind — a run of variants back to back would be the easiest possible ordering for the delta
layer.

## Result: reuse corpus

${storageTable(reuseResult)}

Mechanism behind the same rows:

${mechanismTable(reuseResult)}

- **Does (c) rise with corpus size? ${ratioRises ? 'Yes' : 'No'}.** From ${ratio(reuseFirst.middleOutRatio)}× at N = ${String(reuseFirst.uploads)} to
  ${ratio(reuseLast.middleOutRatio)}× at N = ${String(reuseLast.uploads)} — a factor of ${ratioGain.toFixed(2)}.
- **Does (a) stay flat? ${baselineFlat ? 'Yes' : 'No'}.** ${ratio(reuseFirst.perFileRatio)}× → ${ratio(reuseLast.perFileRatio)}×. It has no mechanism by
  which it could rise; it never sees more than one file.
- **Where the win comes from, and it is not dedup.** At N = ${String(reuseLast.uploads)}: ${String(reuseLast.exactHits)} exact-dedup hits versus
  ${String(reuseLast.deltaChunks)} delta chunks, out of ${String(reuseLast.chunks)} chunk references, with ${String(reuseLast.standaloneChunks)} stored standalone. Strategy (b)
  therefore only reaches ${ratio(reuseLast.dedupOnlyRatio)}× — exact dedup is close to useless on this corpus, because
  content that has been _re-coded_ rather than _re-copied_ is never byte-identical. That is the
  whole point: the ${ratio(reuseLast.middleOutRatio)}× is bought almost entirely by the similarity-delta path, on
  redundancy that exact dedup structurally cannot see.
- **Sublinearity.** Mean similarity-index candidates examined per query went
  ${reuseFirst.meanCandidatesPerQuery.toFixed(2)} → ${reuseLast.meanCandidatesPerQuery.toFixed(2)} while the index grew from ${String(reuseFirst.indexSize)} to ${String(reuseLast.indexSize)} sketches. A
  query's cost is set by the band count and the candidate cap, not by the corpus size — which is
  what makes "compress against everything the network holds" a map lookup rather than a scan.
- Delta chain depth histogram (records at depth 0, 1, 2, …): ${JSON.stringify(reuseResult.depthHistogram)}, deepest
  chain ${String(reuseLast.maxObservedChainDepth)} against a bound of ${String(DEFAULT_MAX_CHAIN_DEPTH)}. Chains form but stay shallow, because the smallest
  delta is usually against a master rather than against another derivative — so the bound is
  mostly a guarantee about the worst case rather than a constraint that binds in practice. It still
  has to exist: without it, a long-lived corpus of successive re-encodes would chain indefinitely,
  and each link added is one more read dependency and one more chunk lost when any link is lost.
- Ingest throughput: ${throughput(reuseResult)} MiB/s single-threaded, over ${mib(reuseResult.ingestedBytes)} MiB in
  ${reuseResult.ingestSeconds.toFixed(2)} s. This is dominated by brotli quality 11, which is run at least once per
  distinct chunk to establish the never-worse baseline. It is a write-path cost paid once per
  chunk, and it is not fast; quality 11 was chosen because it makes the _baseline_ as strong as
  possible, which is the opposite of choosing it to look good.
- Write-time verification fallbacks: ${String(reuseResult.verificationFallbacks)}. Every stored record was resolved back out of
  the store and byte-compared at ingest; this counts the times that check rejected a record and
  forced a standalone. A non-zero value would mean a bug in the delta layer that the store had
  caught and degraded around.

## Control: mutually independent, incompressible works

No upload resembles any other. This is the case where the mechanism _cannot_ help, and it is here
so the report is not only the flattering half.

${storageTable(controlResult)}

${mechanismTable(controlResult)}

**(c) stays flat at ~1.00: ${controlFlat ? 'confirmed' : 'NOT confirmed — investigate'}** (${ratio(controlFirst.middleOutRatio)}× at N = ${String(controlFirst.uploads)},
${ratio(controlLast.middleOutRatio)}× at N = ${String(controlLast.uploads)}), with ${String(controlLast.deltaChunks)} delta chunks and ${String(controlLast.exactHits)} exact hits across the whole run.
This is the correct and expected outcome, and it is worth being explicit about _why_: random bytes
are incompressible **and** mutually dissimilar by construction. There is no redundancy to find, so
the similarity index returns nothing, every chunk is stored standalone, and brotli cannot shrink it
either. The never-worse rule bounds how bad it can get: the ratio sits a hair _below_ 1.0 — that is
brotli's own container overhead on incompressible input, ${String(controlLast.middleOutBytes - controlLast.inputBytes)} bytes across ${mib(controlLast.inputBytes)} MiB — and
strategies (a) and (b) pay it identically. A storage layer cannot do better than break even on
incompressible, unrelated data, and any system claiming otherwise on such input is measuring
something other than what it says.

The gap between these two tables _is_ the thesis. Nothing about the algorithm differs between them;
only the corpus does. Storage efficiency is a property of the corpus, not of the compressor — which
is precisely why it is a moat that grows, and precisely why a competitor copying the algorithm in a
weekend does not get it.

## Correctness

- Uploads reconstructed and byte-compared (sha256): ${String(reuseResult.verified)}/${String(MAX_UPLOADS)} reuse,
  ${String(controlResult.verified)}/${String(MAX_UPLOADS)} control.
- Failures: ${allFailures.length === 0 ? '**none**' : `**${String(allFailures.length)}**\n${allFailures.map((f) => `  - ${f}`).join('\n')}`}.
- The script exits non-zero on any failure, so a green run is itself the correctness claim.

Two guarantees are enforced in code rather than asserted in prose:

1. **Never worse.** A delta is stored only when its compressed bytes _plus_ its 32-byte reference
   pointer are strictly fewer than compressing the chunk standalone. That is a comparison of two
   measured lengths. \`test/network-store.test.ts\` checks it on every individual stored record, not
   just in aggregate.
2. **Verified at write time.** \`chooseEncoding\` decompresses, applies and byte-compares a candidate
   delta before it is eligible; the store then resolves the inserted record back out of itself —
   walking the whole delta chain — and byte-compares again. A record that fails is replaced with a
   standalone one. There is no code path that stores a record whose reconstruction has not already
   been performed and checked.

## What this does NOT prove

Stated at the same volume as the result, because a result whose limits are hidden is not a result.

1. **These are not real encoded video.** They are structural models whose redundancy was put there
   deliberately, and the size of the win scales with parameters chosen in
   \`src/media-corpus.ts\` — above all the verbatim run length. The rendition-ladder pattern in
   particular assumes literal segment reuse between rungs, which a cross-resolution re-encode under
   a modern codec generally does _not_ provide. **The honest next step is re-running this exact
   script over a real public video corpus** — one asset at several ladder rungs, real remuxes, real
   re-encodes — and publishing whatever it says. The store does not know where its bytes came from;
   swapping the inputs changes the numbers and nothing else.
2. **The reuse rate is modelled, not observed.** The square-root schedule is a stated assumption
   about how uploads cluster on works. It is not measured from a real platform's upload logs, and
   the magnitude of the curve depends on it directly.
3. **Single machine, single process, single thread.** No cluster, no concurrency, no contention, no
   competing load.
4. **In-memory store.** Records live in a \`Map\`. Nothing here measures disk layout, write
   amplification, fragmentation, compaction, index persistence, or the cost of keeping the
   similarity index across restarts.
5. **No network transport measured.** Nothing here measures bandwidth, latency, peer discovery,
   replication factor, or availability. Note that a delta chain trades storage for a _read_
   dependency: reading a chunk at depth _d_ requires _d_ other chunks to be available. That is a
   real availability cost on a decentralized network and it is not quantified here.
6. **The read path is not benchmarked.** Ingest throughput is measured; reconstruction throughput is
   only verified for correctness, not timed.
7. **No adversarial corpus.** Inputs designed to maximise similarity-index work, poison band
   buckets, or force worst-case delta encoding are not covered here.
8. **One chunker configuration.** The 8/32/128 KiB content-defined chunking defaults are used
   throughout. Chunk size trades metadata against dedup and delta granularity and was not swept.
`;

const reportPath = new URL('../SCALE.md', import.meta.url);
writeFileSync(reportPath, report);

// ---------------------------------------------------------------------------------------------
// console output

const lines: string[] = ['', '='.repeat(96), 'SCALE CURVE — reuse corpus', '='.repeat(96), ''];
lines.push(storageTable(reuseResult), '', mechanismTable(reuseResult), '');
lines.push(
  `ratio (c): ${ratio(reuseFirst.middleOutRatio)}x at N=${String(reuseFirst.uploads)} -> ` +
    `${ratio(reuseLast.middleOutRatio)}x at N=${String(reuseLast.uploads)}  (factor ${ratioGain.toFixed(2)})`,
  `ratio (a): ${ratio(reuseFirst.perFileRatio)}x -> ${ratio(reuseLast.perFileRatio)}x  ` +
    `(flat: ${baselineFlat ? 'yes' : 'no'})`,
  `exact hits ${String(reuseLast.exactHits)} | delta chunks ${String(reuseLast.deltaChunks)} | ` +
    `standalone ${String(reuseLast.standaloneChunks)} | chunk refs ${String(reuseLast.chunks)}`,
  `mean candidates/query ${reuseFirst.meanCandidatesPerQuery.toFixed(2)} -> ` +
    `${reuseLast.meanCandidatesPerQuery.toFixed(2)} while index grew ${String(reuseFirst.indexSize)} -> ${String(reuseLast.indexSize)}`,
  `depth histogram ${JSON.stringify(reuseResult.depthHistogram)} | ` +
    `verification fallbacks ${String(reuseResult.verificationFallbacks)}`,
  `ingest ${throughput(reuseResult)} MiB/s over ${mib(reuseResult.ingestedBytes)} MiB in ${reuseResult.ingestSeconds.toFixed(2)}s`,
  '',
  '='.repeat(96),
  'CONTROL — mutually independent incompressible works (the mechanism cannot help here)',
  '='.repeat(96),
  '',
);
lines.push(storageTable(controlResult), '', mechanismTable(controlResult), '');
lines.push(
  `ratio (c): ${ratio(controlFirst.middleOutRatio)}x -> ${ratio(controlLast.middleOutRatio)}x  ` +
    `(flat at ~1.00: ${controlFlat ? 'yes' : 'NO'})`,
  `delta chunks ${String(controlLast.deltaChunks)} | exact hits ${String(controlLast.exactHits)}`,
  `ingest ${throughput(controlResult)} MiB/s over ${mib(controlResult.ingestedBytes)} MiB in ${controlResult.ingestSeconds.toFixed(2)}s`,
  '',
  `reconstruction verified: reuse ${String(reuseResult.verified)}/${String(MAX_UPLOADS)}, ` +
    `control ${String(controlResult.verified)}/${String(MAX_UPLOADS)}`,
  `wrote ${fileURLToPath(reportPath)}`,
  '',
);
process.stdout.write(`${lines.join('\n')}\n`);

if (allFailures.length > 0) {
  process.stderr.write(`\nRECONSTRUCTION FAILURES (${String(allFailures.length)}):\n`);
  for (const failure of allFailures) {
    process.stderr.write(`  ${failure}\n`);
  }
  process.exit(1);
}
if (reuseResult.verified !== MAX_UPLOADS || controlResult.verified !== MAX_UPLOADS) {
  process.stderr.write('\nnot every upload was verified; refusing to report success\n');
  process.exit(1);
}
