/**
 * The middle-out measurement harness.
 *
 * Rules this file follows, because a compression benchmark with no adversary is marketing:
 *   - every codec's output is decompressed and byte-compared against the exact input, and a
 *     codec that fails that check gets no ratio printed and fails the run;
 *   - the standard is gzip -9 and the challenger is brotli -11 with a size hint, both from
 *     `node:zlib`, on the identical byte arrays;
 *   - nothing is written here by hand. Every number in BENCHMARK.md comes from this run.
 *
 * Run: pnpm --filter @wokenet/middle-out bench
 */

import { cpus } from 'node:os';
import { createHash } from 'node:crypto';
import { register } from 'node:module';
import { writeFileSync } from 'node:fs';
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  gunzipSync,
  gzipSync,
} from 'node:zlib';

// Type-only namespace imports. The runtime imports are dynamic and further down, because the
// resolve hook registered below has to be in place before any `src/` module is loaded, and
// because a module that has not been written yet must degrade to 'unavailable' rather than
// crash the harness.
import type * as ChunkingNamespace from '../src/chunking.js';
import type * as CorpusNamespace from '../src/corpus.js';
import type * as DedupNamespace from '../src/dedup.js';
import type * as TranscodeNamespace from '../src/transcode.js';

/**
 * `src/` imports its siblings with `.js` specifiers (the repo's TypeScript settings require it),
 * but Node's type stripping resolves specifiers literally and will not try `./x.ts` for `./x.js`.
 * This resolve hook closes that gap so the harness can run straight off the sources with no build
 * step. It only redirects relative `.js` specifiers that have no `.js` file on disk.
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ChunkingModule = typeof ChunkingNamespace;
type CorpusModule = typeof CorpusNamespace;
type DedupModule = typeof DedupNamespace;
type TranscodeModule = typeof TranscodeNamespace;

const unavailable: string[] = [];

async function loadOptional<T>(load: () => Promise<T>, name: string): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    unavailable.push(`${name}: ${describeError(error)}`);
    return null;
  }
}

const corpus: CorpusModule = await import('../src/corpus.js');
const chunking = await loadOptional<ChunkingModule>(() => import('../src/chunking.js'), 'chunking');
const dedup = await loadOptional<DedupModule>(() => import('../src/dedup.js'), 'dedup');
const transcode = await loadOptional<TranscodeModule>(
  () => import('../src/transcode.js'),
  'transcode',
);

// ---------------------------------------------------------------------------------------------
// codecs

interface Codec {
  readonly id: string;
  readonly label: string;
  readonly compress: (input: Uint8Array) => Uint8Array;
  readonly decompress: (input: Uint8Array) => Uint8Array;
  /** False for the identity codec: it does no work, so its throughput is not a real number. */
  readonly timed: boolean;
}

const RAW: Codec = {
  id: 'raw',
  label: 'raw (identity)',
  compress: (input) => input,
  decompress: (input) => input,
  timed: false,
};

const GZIP_9: Codec = {
  id: 'gzip-9',
  label: 'gzip -9',
  compress: (input) => gzipSync(input, { level: 9 }),
  decompress: (input) => gunzipSync(input),
  timed: true,
};

const BROTLI_11: Codec = {
  id: 'brotli-11',
  label: 'brotli -q11 (+size hint)',
  compress: (input) =>
    brotliCompressSync(input, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: input.length,
      },
    }),
  decompress: (input) => brotliDecompressSync(input),
  timed: true,
};

const MIDDLE_OUT: Codec | null =
  transcode === null
    ? null
    : {
        id: 'middle-out',
        label: 'middle-out',
        compress: transcode.encodeMiddleOut,
        decompress: transcode.decodeMiddleOut,
        timed: true,
      };

const CODECS: readonly Codec[] = [
  RAW,
  GZIP_9,
  BROTLI_11,
  ...(MIDDLE_OUT === null ? [] : [MIDDLE_OUT]),
];

const STANDARD_CODEC_ID = GZIP_9.id;
const CHALLENGER_CODEC_ID = 'middle-out';

/**
 * Weissman parameters, stated in the output so the number can be rechecked by hand.
 *
 * The time unit is microseconds, and that choice is not cosmetic: the formula takes the logarithm
 * of a bare duration, so W moves when the unit moves. Microseconds keep every time measured in
 * this suite well clear of the clamp, which is the only way every row gets a defined score at all.
 */
const WEISSMAN_ALPHA = 1;
const WEISSMAN_TIME_UNIT = 'us';
const WEISSMAN_MIN_TIME = 1;

/** Documents pushed through a codec before the clock starts, so JIT warm-up is not measured. */
const WARMUP_DOCUMENTS = 8;

// ---------------------------------------------------------------------------------------------
// measurement

interface Measurement {
  readonly codecId: string;
  readonly codecLabel: string;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly compressMs: number;
  readonly decompressMs: number;
  readonly verified: boolean;
  readonly failure: string | null;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function totalLength(documents: readonly Uint8Array[]): number {
  let total = 0;
  for (const document of documents) {
    total += document.length;
  }
  return total;
}

function elapsedMs(startNs: bigint): number {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}

function measure(codec: Codec, documents: readonly Uint8Array[]): Measurement {
  const base = {
    codecId: codec.id,
    codecLabel: codec.label,
    inputBytes: totalLength(documents),
  };
  try {
    for (let i = 0; i < Math.min(WARMUP_DOCUMENTS, documents.length); i += 1) {
      const document = documents[i];
      if (document !== undefined) {
        codec.decompress(codec.compress(document));
      }
    }

    const encoded: Uint8Array[] = [];
    const compressStart = process.hrtime.bigint();
    for (const document of documents) {
      encoded.push(codec.compress(document));
    }
    const compressMs = elapsedMs(compressStart);

    const decoded: Uint8Array[] = [];
    const decompressStart = process.hrtime.bigint();
    for (const block of encoded) {
      decoded.push(codec.decompress(block));
    }
    const decompressMs = elapsedMs(decompressStart);

    for (let i = 0; i < documents.length; i += 1) {
      const original = documents[i];
      const roundTripped = decoded[i];
      if (original === undefined || roundTripped === undefined) {
        return {
          ...base,
          outputBytes: 0,
          compressMs,
          decompressMs,
          verified: false,
          failure: `document count mismatch at index ${String(i)}`,
        };
      }
      if (!bytesEqual(original, roundTripped)) {
        return {
          ...base,
          outputBytes: 0,
          compressMs,
          decompressMs,
          verified: false,
          failure: `round trip differs from input at document ${String(i)}`,
        };
      }
    }

    return {
      ...base,
      outputBytes: totalLength(encoded),
      compressMs,
      decompressMs,
      verified: true,
      failure: null,
    };
  } catch (error) {
    return {
      ...base,
      outputBytes: 0,
      compressMs: 0,
      decompressMs: 0,
      verified: false,
      failure: `threw: ${describeError(error)}`,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// corpora

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(totalLength(parts));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const PROTOCOL_COUNT = 500;
const MANIFEST_COUNT = 200;

const protocolDocuments = corpus.generateProtocolCorpus(PROTOCOL_COUNT);
const manifestDocuments = corpus.generateMediaManifestCorpus(MANIFEST_COUNT);
const video = corpus.generateVideoSegmentCorpus();

const videoSegments: Uint8Array[] = video.renditions.flat();
const renditionStreams: Uint8Array[] = video.renditions.map((segments) => concatBytes(segments));
const originalStream = renditionStreams[0] ?? new Uint8Array(0);
const reuploadStream = concatBytes(video.reuploadWithIntro);

interface Scenario {
  readonly corpusName: string;
  /** `per-document` = each document compressed alone, as it travels on the wire. */
  readonly mode: string;
  readonly documents: readonly Uint8Array[];
}

const SCENARIOS: readonly Scenario[] = [
  {
    corpusName: 'protocol envelopes',
    mode: 'per-document',
    documents: protocolDocuments,
  },
  {
    corpusName: 'protocol envelopes',
    mode: 'single stream',
    documents: [concatBytes(protocolDocuments)],
  },
  {
    corpusName: 'media manifests',
    mode: 'per-document',
    documents: manifestDocuments,
  },
  {
    corpusName: 'media manifests',
    mode: 'single stream',
    documents: [concatBytes(manifestDocuments)],
  },
  {
    corpusName: 'video segments',
    mode: 'per-segment',
    documents: videoSegments,
  },
  {
    corpusName: 'video segments',
    mode: 'single stream',
    documents: [concatBytes(videoSegments)],
  },
];

// ---------------------------------------------------------------------------------------------
// dedup (layer 1)

interface DedupRow {
  readonly scenario: string;
  readonly sources: number;
  readonly totalBytes: number;
  readonly storedBytes: number;
  readonly totalChunks: number;
  readonly uniqueChunks: number;
  readonly dedupRatio: number;
}

interface OverlapRow {
  readonly strategy: string;
  readonly candidateBytes: number;
  readonly matchedBytes: number;
  readonly candidateBlocks: number;
  readonly matchedBlocks: number;
}

const FIXED_BLOCK_SIZE = 32 * 1024;

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The baseline content-defined chunking has to beat: split at fixed offsets, address each block.
 * Run at the same nominal size as the chunker's average so the comparison is like-for-like.
 */
function fixedBlockOverlap(base: Uint8Array, candidate: Uint8Array, blockSize: number): OverlapRow {
  const seen = new Set<string>();
  for (let offset = 0; offset < base.length; offset += blockSize) {
    seen.add(sha256Hex(base.subarray(offset, Math.min(offset + blockSize, base.length))));
  }
  let matchedBlocks = 0;
  let matchedBytes = 0;
  let candidateBlocks = 0;
  for (let offset = 0; offset < candidate.length; offset += blockSize) {
    const end = Math.min(offset + blockSize, candidate.length);
    candidateBlocks += 1;
    if (seen.has(sha256Hex(candidate.subarray(offset, end)))) {
      matchedBlocks += 1;
      matchedBytes += end - offset;
    }
  }
  return {
    strategy: `fixed-size blocking (${int(blockSize)} B)`,
    candidateBytes: candidate.length,
    matchedBytes,
    candidateBlocks,
    matchedBlocks,
  };
}

function contentDefinedOverlap(
  chunkingModule: ChunkingModule,
  dedupModule: DedupModule,
  base: Uint8Array,
  candidate: Uint8Array,
): OverlapRow {
  const store = new dedupModule.ContentAddressedStore();
  store.put(base);
  const chunks = chunkingModule.chunkBytes(candidate);
  let matchedBlocks = 0;
  let matchedBytes = 0;
  for (const chunk of chunks) {
    const view = candidate.subarray(chunk.offset, chunk.offset + chunk.length);
    if (store.has(dedupModule.digestChunkSync(view))) {
      matchedBlocks += 1;
      matchedBytes += chunk.length;
    }
  }
  return {
    strategy: 'content-defined chunking',
    candidateBytes: candidate.length,
    matchedBytes,
    candidateBlocks: chunks.length,
    matchedBlocks,
  };
}

function collectDedupRows(dedupModule: DedupModule): DedupRow[] {
  const cases: readonly { readonly scenario: string; readonly sources: readonly Uint8Array[] }[] = [
    {
      scenario: 'renditions, one source per encoded segment',
      sources: videoSegments,
    },
    {
      scenario: 'renditions, one source per rendition stream',
      sources: renditionStreams,
    },
    {
      scenario: 'original stream + re-upload with intro prepended',
      sources: [originalStream, reuploadStream],
    },
    {
      scenario: 'everything: all renditions + the re-upload',
      sources: [...renditionStreams, reuploadStream],
    },
  ];
  return cases.map(({ scenario, sources }) => {
    const stats = dedupModule.measureDedup(sources);
    return {
      scenario,
      sources: sources.length,
      totalBytes: stats.totalBytes,
      storedBytes: stats.storedBytes,
      totalChunks: stats.totalChunks,
      uniqueChunks: stats.uniqueChunks,
      dedupRatio: stats.dedupRatio,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// formatting

function int(value: number): string {
  return value.toLocaleString('en-US');
}

function fixed(value: number, digits: number): string {
  return value.toFixed(digits);
}

function throughput(bytes: number, ms: number): string {
  if (ms <= 0) return 'n/a';
  return fixed(bytes / 1e6 / (ms / 1000), 1);
}

function percent(part: number, whole: number): string {
  if (whole === 0) return 'n/a';
  return `${fixed((part / whole) * 100, 2)}%`;
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
}

interface WeissmanResult {
  readonly value: number | null;
  readonly formula: string;
}

function weissman(
  challenger: Measurement,
  standard: Measurement,
  challengerRatio: number,
  standardRatio: number,
): WeissmanResult {
  const time = Math.max(challenger.compressMs * 1000, WEISSMAN_MIN_TIME);
  const standardTime = Math.max(standard.compressMs * 1000, WEISSMAN_MIN_TIME);
  const logTime = Math.log(time);
  const substituted =
    `W = ${String(WEISSMAN_ALPHA)} x (${fixed(challengerRatio, 4)} / ${fixed(standardRatio, 4)})` +
    ` x (ln(${fixed(standardTime, 3)}) / ln(${fixed(time, 3)}))`;
  if (logTime === 0) {
    return {
      value: null,
      formula: `${substituted} = undefined (ln(1) = 0; compression time hit the ${String(
        WEISSMAN_MIN_TIME,
      )} ${WEISSMAN_TIME_UNIT} clamp)`,
    };
  }
  const value =
    WEISSMAN_ALPHA * (challengerRatio / standardRatio) * (Math.log(standardTime) / logTime);
  return { value, formula: `${substituted} = ${fixed(value, 4)}` };
}

// ---------------------------------------------------------------------------------------------
// run

const failures: string[] = [];
const lines: string[] = [];

function emit(...newLines: readonly string[]): void {
  if (newLines.length === 0) {
    lines.push('');
    return;
  }
  lines.push(...newLines);
}

const cpuModel = cpus()[0]?.model ?? 'unknown';

emit('# middle-out — measured benchmark');
emit();
emit(
  'Generated by `packages/middle-out/scripts/benchmark.ts`. Every number in this file was produced',
);
emit('by the run that wrote it. Nothing here is hand-written or estimated.');
emit();
emit('## Reproduce');
emit();
emit('```sh');
emit('pnpm install');
emit('pnpm --filter @wokenet/middle-out bench');
emit('```');
emit();
emit('## Inputs (machine-independent)');
emit();
emit(
  'The corpora are generated by `src/corpus.ts` from fixed seeds with an inline splitmix32 PRNG,',
);
emit('so these byte counts are identical on every machine and every run.');
emit();
emit(
  ...table(
    ['Corpus', 'Documents', 'Total bytes', 'Mean document', 'Seed'],
    [
      [
        'protocol envelopes',
        int(protocolDocuments.length),
        int(totalLength(protocolDocuments)),
        int(Math.round(totalLength(protocolDocuments) / protocolDocuments.length)),
        `0x${corpus.CORPUS_SEEDS.protocol.toString(16)}`,
      ],
      [
        'media manifests',
        int(manifestDocuments.length),
        int(totalLength(manifestDocuments)),
        int(Math.round(totalLength(manifestDocuments) / manifestDocuments.length)),
        `0x${corpus.CORPUS_SEEDS.mediaManifest.toString(16)}`,
      ],
      [
        'video segments (all renditions)',
        int(videoSegments.length),
        int(totalLength(videoSegments)),
        int(Math.round(totalLength(videoSegments) / videoSegments.length)),
        `0x${corpus.CORPUS_SEEDS.videoSegments.toString(16)}`,
      ],
      [
        'video re-upload with intro',
        int(video.reuploadWithIntro.length),
        int(reuploadStream.length),
        int(Math.round(reuploadStream.length / video.reuploadWithIntro.length)),
        `0x${corpus.CORPUS_SEEDS.videoSegments.toString(16)}`,
      ],
    ],
  ),
);
emit();
emit('## Environment (machine-dependent — timings only)');
emit();
emit(`- Node ${process.version}, ${process.platform}/${process.arch}`);
emit(`- CPU: ${cpuModel}`);
emit(`- Codecs: ${CODECS.map((codec) => codec.label).join(', ')}`);
if (unavailable.length > 0) {
  emit(`- Unavailable modules: ${unavailable.join('; ')}`);
}
emit();
emit('## Layer 2 — compression of protocol and media metadata');
emit();
emit('`Ratio` is input bytes / output bytes. A codec that fails the byte-exact round-trip check');
emit(
  'gets no ratio at all — the row reports the failure instead. The identity codec does no work,',
);
emit('so its throughput columns are left blank rather than filled with a meaningless number.');
emit();
emit('Two modes are measured for every corpus, because they answer different questions:');
emit();
emit('- `per-document` is the wire case: each envelope or manifest is compressed alone, with no');
emit('  cross-document context, exactly as it travels between peers.');
emit('- `single stream` is the archive case: the whole corpus concatenated into one buffer, which');
emit('  hands gzip and brotli a sliding window over every document at once.');
emit();
emit(
  'middle-out is a *per-document* transcoder: it parses one canonical document into a typed middle',
);
emit(
  'representation. A concatenation of 500 documents is not one document, so on the `single stream`',
);
emit(
  'rows the transcoder declines, self-verification confirms the fallback, and the container stores',
);
emit(
  'the input verbatim. That is what a ratio of exactly 1.0000 with a handful of extra bytes is: the',
);
emit('passthrough guarantee firing, visible as container overhead and nothing else.');
emit();

const measurementsByScenario = new Map<string, Map<string, Measurement>>();
const compressionRows: string[][] = [];

for (const scenario of SCENARIOS) {
  const key = `${scenario.corpusName} / ${scenario.mode}`;
  const perCodec = new Map<string, Measurement>();
  for (const codec of CODECS) {
    const result = measure(codec, scenario.documents);
    perCodec.set(codec.id, result);
    if (!result.verified) {
      failures.push(`${key} / ${codec.label}: ${result.failure ?? 'verification failed'}`);
    }
    compressionRows.push([
      scenario.corpusName,
      scenario.mode,
      codec.label,
      int(result.inputBytes),
      result.verified ? int(result.outputBytes) : '—',
      result.verified ? fixed(result.inputBytes / result.outputBytes, 4) : '—',
      result.verified && codec.timed ? throughput(result.inputBytes, result.compressMs) : '—',
      result.verified && codec.timed ? throughput(result.inputBytes, result.decompressMs) : '—',
      result.verified ? 'pass' : `FAIL (${result.failure ?? 'unknown'})`,
    ]);
  }
  measurementsByScenario.set(key, perCodec);
}

emit(
  ...table(
    [
      'Corpus',
      'Mode',
      'Codec',
      'Bytes in',
      'Bytes out',
      'Ratio',
      'Comp MB/s',
      'Decomp MB/s',
      'Round trip',
    ],
    compressionRows,
  ),
);
emit();

emit('## Weissman score');
emit();
emit(`Standard: \`${STANDARD_CODEC_ID}\`. Challenger: \`${CHALLENGER_CODEC_ID}\`.`);
emit();
emit('```');
emit('W = alpha * (ratio / ratio_standard) * (log(time_standard) / log(time))');
emit('```');
emit();
emit(`alpha = ${String(WEISSMAN_ALPHA)}, set explicitly and never tuned.`);
emit();
emit(
  `Both times are compression times in ${WEISSMAN_TIME_UNIT} (microseconds) — the same unit for`,
);
emit(
  `challenger and standard — clamped below to ${String(WEISSMAN_MIN_TIME)} ${WEISSMAN_TIME_UNIT},`,
);
emit(
  'so the logarithm stays finite and positive. The substituted formula is printed on every row,',
);
emit('so every value can be rechecked by hand.');
emit();
emit('Two properties of this formula are worth stating plainly before reading the column:');
emit();
emit(
  '- **It is unit-dependent.** It takes `log` of a bare duration, so W changes if you switch to ms',
);
emit('  or seconds. These numbers are comparable only against other runs of this same harness.');
emit(
  '- **It rewards speed, not only ratio.** A codec that compresses nothing can score above 1 by',
);
emit(
  '  being fast, and a codec that compresses better but slower scores below it. The ratio column',
);
emit('  in the table above is the number that means something.');
emit();

if (MIDDLE_OUT === null) {
  emit('**unavailable** — the `middle-out` codec did not load, so no Weissman score was computed.');
} else {
  const weissmanRows: string[][] = [];
  for (const scenario of SCENARIOS) {
    const key = `${scenario.corpusName} / ${scenario.mode}`;
    const perCodec = measurementsByScenario.get(key);
    const challenger = perCodec?.get(CHALLENGER_CODEC_ID);
    const standard = perCodec?.get(STANDARD_CODEC_ID);
    if (challenger === undefined || standard === undefined) continue;
    if (!challenger.verified || !standard.verified) {
      weissmanRows.push([
        scenario.corpusName,
        scenario.mode,
        '—',
        'not computed: a codec failed verification',
      ]);
      continue;
    }
    const challengerRatio = challenger.inputBytes / challenger.outputBytes;
    const standardRatio = standard.inputBytes / standard.outputBytes;
    const score = weissman(challenger, standard, challengerRatio, standardRatio);
    weissmanRows.push([
      scenario.corpusName,
      scenario.mode,
      score.value === null ? '—' : fixed(score.value, 4),
      score.formula,
    ]);
  }
  emit(...table(['Corpus', 'Mode', 'W', 'Substituted formula'], weissmanRows));
}
emit();

emit('## Layer 1 — content-defined chunking and global dedup');
emit();

if (dedup === null || chunking === null) {
  emit('**unavailable** — `src/dedup.ts` and/or `src/chunking.ts` did not load, so no dedup');
  emit('measurement was taken. No numbers are reported for this layer.');
} else {
  emit(
    `Chunker defaults: min ${int(chunking.DEFAULT_CHUNKING_OPTIONS.minSize)} B, avg ` +
      `${int(chunking.DEFAULT_CHUNKING_OPTIONS.avgSize)} B, max ` +
      `${int(chunking.DEFAULT_CHUNKING_OPTIONS.maxSize)} B.`,
  );
  emit();
  emit(
    '`Stored bytes` is what a content-addressed store actually holds after every source has been',
  );
  emit('put into it — each distinct chunk once, network-wide.');
  emit();
  emit(
    ...table(
      [
        'Scenario',
        'Sources',
        'Total bytes',
        'Stored bytes',
        'Chunks',
        'Unique chunks',
        'Dedup ratio',
        'Bytes saved',
      ],
      collectDedupRows(dedup).map((row) => [
        row.scenario,
        int(row.sources),
        int(row.totalBytes),
        int(row.storedBytes),
        int(row.totalChunks),
        int(row.uniqueChunks),
        fixed(row.dedupRatio, 4),
        `${int(row.totalBytes - row.storedBytes)} (${percent(
          row.totalBytes - row.storedBytes,
          row.totalBytes,
        )})`,
      ]),
    ),
  );
  emit();
  emit('### The insertion case: re-upload with an intro prepended');
  emit();
  emit(
    `The re-upload is the same video with ${int(
      reuploadStream.length - originalStream.length,
    )} bytes of intro prepended, so every`,
  );
  emit(
    'subsequent byte is shifted by a non-multiple of any block size. How much of the re-upload is',
  );
  emit('already in the store after only the original has been stored:');
  emit();
  const overlapRows: OverlapRow[] = [
    contentDefinedOverlap(chunking, dedup, originalStream, reuploadStream),
    fixedBlockOverlap(originalStream, reuploadStream, FIXED_BLOCK_SIZE),
  ];
  emit(
    ...table(
      ['Strategy', 'Re-upload bytes', 'Blocks', 'Blocks already stored', 'Bytes already stored'],
      overlapRows.map((row) => [
        row.strategy,
        int(row.candidateBytes),
        int(row.candidateBlocks),
        `${int(row.matchedBlocks)} (${percent(row.matchedBlocks, row.candidateBlocks)})`,
        `${int(row.matchedBytes)} (${percent(row.matchedBytes, row.candidateBytes)})`,
      ]),
    ),
  );
}
emit();

emit('## What this does NOT prove');
emit();
emit(
  '- **middle-out is not a pixel codec.** Nothing here competes with AV1, HEVC or H.264 at coding',
);
emit(
  '  image data. Layer 1 stores encoded segments produced by those codecs exactly once; Layer 2',
);
emit('  compresses the envelopes and manifests around them. Neither re-encodes a frame.');
emit('- **The video segments are synthetic high-entropy bytes.** They stand in for real encoded');
emit(
  '  video. That makes them the hard case for the compressors (there is nothing to model), but it',
);
emit(
  '  also means the dedup ratios reflect the reuse pattern the generator was told to simulate —',
);
emit('  shared stingers, mirrored rungs, one re-upload — not a measured distribution from a real');
emit('  network. Point it at real segments to get a real number.');
emit(
  '- **The `single stream` rows flatter the general-purpose compressors, on purpose.** Handed one',
);
emit(
  '  concatenated stream, gzip and brotli can dedup within their own sliding window, and brotli',
);
emit('  at q11 does. That is the honest comparison and it is included. Layer 1 differs by being');
emit('  global and persistent: a chunk stored once is not re-sent to anyone, ever, across streams');
emit('  that no single compressor window will ever hold at the same time.');
emit(
  '- **Timings are single-machine, single-run, one process.** Ratios are exact and portable; MB/s',
);
emit('  and therefore the Weissman score are not. Re-run on your own hardware.');
emit(
  '- **The Weissman score is a made-up metric** from a television show, reported because it was',
);
emit('  asked for. alpha = 1 and the time unit is stated above; it is a presentation of the ratio');
emit('  and time numbers in the same table, not independent evidence.');
emit();

if (failures.length > 0) {
  emit('## Verification failures');
  emit();
  for (const failure of failures) {
    emit(`- ${failure}`);
  }
  emit();
}

const report = `${lines.join('\n')}\n`;
process.stdout.write(report);
writeFileSync(new URL('../BENCHMARK.md', import.meta.url), report, 'utf8');

if (failures.length > 0) {
  process.stdout.write(`\n${String(failures.length)} verification failure(s). Exiting non-zero.\n`);
  process.exitCode = 1;
}
