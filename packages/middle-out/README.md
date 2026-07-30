# @wokenet/middle-out

Middle-out is WokeNet's compression program. It exists to make a fully decentralized video
network — on-chain references plus content-addressed media, high quality, fast — economically and
energetically viable.

It is **not** a claim to beat AV1, HEVC or H.264 at coding pixels. It never touches a frame. It
attacks the two places where a decentralized video network actually wastes bytes: storing the same
media over and over, and shipping metadata made of text-encoded randomness.

Both layers are measurable, and both are measured. Every number in this file came out of
`scripts/benchmark.ts`; see [BENCHMARK.md](./BENCHMARK.md) for the full report and the
"what this does not prove" section.

---

## Layer 1 — content-defined chunking and global dedup

**The claim.** In a content-addressed network each unique chunk is stored and transferred exactly
once — across every rendition, every mirror, every re-upload and every edit the network has ever
seen. Fixed-size blocking throws that away the moment a byte is inserted: every following block
shifts, re-hashes, and looks new. A content-defined boundary is a function of the bytes around it,
so the boundary stream resynchronizes after an edit and the dedup survives.

**Why it matters for video.** Creators re-upload. Platforms mirror. Editors trim a second off the
front and republish. Ladder rungs share pre-rendered intros, outros and sponsor stingers. Every one
of those is a near-duplicate that fixed-size blocking pays full price for and content-defined
chunking does not.

```ts
import { chunkBytes, measureDedup, ContentAddressedStore } from '@wokenet/middle-out';

const chunks = chunkBytes(bytes); // [{ offset, length }, ...]
const stats = measureDedup([originalUpload, reuploadWithIntro]);
// stats.dedupRatio, stats.storedBytes, stats.uniqueChunks

const store = new ContentAddressedStore();
const manifest = store.put(bytes);
// store.get(manifest) is byte-identical to bytes, always
```

## Layer 2 — typed middle-representation transcoding

**The claim.** Protocol envelopes, media manifests and HLS playlists are mostly *encoded
randomness*:

| Field | Encoding | Length |
| --- | --- | --- |
| ed25519 public key | base58btc | 44 chars |
| content digest | multibase base64url (`u…`) | 44 chars |
| CIDv1 raw/sha2-256 | multibase base32 (`bafkrei…`) | 59 chars |
| composite identity id | `woke:id:v1:<key>:<cid>:<digest>` | 160 chars |
| timestamp | exact-millisecond ISO-8601 | 24 chars |
| counters | decimal strings | varies |

It is tempting to say a general-purpose compressor cannot recover that expansion. **That would be
wrong, and this repository's own measurements say so.** gzip and brotli are not pure LZ: both
Huffman-code their literals, and a base58 string is a near-uniform stream over 58 symbols, which a
Huffman stage prices near log2(58) = 5.86 bits instead of 8. On a corpus of nothing but base58
keys, brotli -q11 lands within a few percent of the 32-bytes-per-key information floor entirely on
its own. `test/adversarial.test.ts` measures this and annotates the numbers.

So the honest claim is narrower and it is the one the table below supports. Parsing **inward** to a
typed middle representation — raw bytes, varints, dictionary references, structural tags — and
entropy-coding **outward** from that middle wins because it reaches the floor *deterministically*
rather than statistically. It undoes a known transformation instead of modelling one. The size
margin over brotli -q11 on the base-N forms alone is a low single-digit percentage. Where the
margin is worth having is where the encoding carries structure a statistical model has no reason to
find: exact-millisecond timestamps collapsing to one varint, decimal-string counters collapsing to
another, and a shared composite-identifier prefix collapsing to a single dictionary reference.

Read the measured tables, not this paragraph. On the wire case, middle-out wins on media manifests
and **loses to brotli -q11 on protocol envelopes**; both results are below.

```ts
import { encodeMiddleOut, decodeMiddleOut } from '@wokenet/middle-out';

const container = encodeMiddleOut(canonicalJsonBytes);
const back = decodeMiddleOut(container); // byte-identical to canonicalJsonBytes
```

## Losslessness is structural, not hoped for

`encodeMiddleOut` decodes its own output and byte-compares it against the exact input **before
returning**. On any mismatch it discards the transcode and returns a passthrough container holding
the raw bytes with a flag.

The consequence is worth being precise about: a bug anywhere in the transcoder can cost compression
ratio. It cannot corrupt data. There is no code path that returns a container the encoder has not
already round-tripped. You can see this firing in the measured table below — the `single stream`
rows sit at a ratio of exactly 1.0000 with 8 extra bytes, because a concatenation of 500 documents
is not one parseable document, so the transcoder declined and the container stored the input
verbatim.

## Running the benchmark

```sh
pnpm install
pnpm --filter @wokenet/middle-out bench
```

The harness generates its corpora deterministically from fixed seeds (`src/corpus.ts`, inline
splitmix32 — no `Math.random`, no `Date.now`), compresses each one with raw/gzip -9/brotli -q11
with a size hint/middle-out, verifies every codec's round trip byte-for-byte, refuses to print a
ratio for any codec that fails verification, and exits non-zero if any verification failed. It
writes [BENCHMARK.md](./BENCHMARK.md) and prints the same report to stdout.

---

## Measured results

Copied verbatim from the run that produced [BENCHMARK.md](./BENCHMARK.md). Byte counts and ratios
are deterministic and will reproduce anywhere; throughput will not.

- Node v22.23.1, darwin/arm64, Apple M5 Pro.

### Inputs

| Corpus | Documents | Total bytes | Mean document | Seed |
| --- | --- | --- | --- | --- |
| protocol envelopes | 500 | 620,044 | 1,240 | 0x574f4b45 |
| media manifests | 200 | 7,235,375 | 36,177 | 0x4d414e49 |
| video segments (all renditions) | 192 | 1,487,808 | 7,749 | 0x56494445 |
| video re-upload with intro | 49 | 594,827 | 12,139 | 0x56494445 |

### Layer 2 — compression

`per-document` is the wire case (each document compressed alone). `single stream` is the archive
case (the whole corpus concatenated, which hands gzip and brotli a window over everything at once).

| Corpus | Mode | Codec | Bytes in | Bytes out | Ratio | Comp MB/s | Decomp MB/s | Round trip |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| protocol envelopes | per-document | raw (identity) | 620,044 | 620,044 | 1.0000 | — | — | pass |
| protocol envelopes | per-document | gzip -9 | 620,044 | 457,165 | 1.3563 | 54.1 | 141.0 | pass |
| protocol envelopes | per-document | brotli -q11 (+size hint) | 620,044 | 415,451 | 1.4925 | 1.2 | 129.6 | pass |
| protocol envelopes | per-document | middle-out | 620,044 | 434,232 | 1.4279 | 0.8 | 35.6 | pass |
| protocol envelopes | single stream | raw (identity) | 620,044 | 620,044 | 1.0000 | — | — | pass |
| protocol envelopes | single stream | gzip -9 | 620,044 | 271,126 | 2.2869 | 98.9 | 643.5 | pass |
| protocol envelopes | single stream | brotli -q11 (+size hint) | 620,044 | 246,421 | 2.5162 | 1.2 | 311.8 | pass |
| protocol envelopes | single stream | middle-out | 620,044 | 620,052 | 1.0000 | 993.7 | 14322.4 | pass |
| media manifests | per-document | raw (identity) | 7,235,375 | 7,235,375 | 1.0000 | — | — | pass |
| media manifests | per-document | gzip -9 | 7,235,375 | 2,724,408 | 2.6558 | 80.9 | 577.8 | pass |
| media manifests | per-document | brotli -q11 (+size hint) | 7,235,375 | 2,430,416 | 2.9770 | 1.5 | 373.4 | pass |
| media manifests | per-document | middle-out | 7,235,375 | 2,358,950 | 3.0672 | 1.9 | 33.7 | pass |
| media manifests | single stream | raw (identity) | 7,235,375 | 7,235,375 | 1.0000 | — | — | pass |
| media manifests | single stream | gzip -9 | 7,235,375 | 2,608,806 | 2.7734 | 59.7 | 629.0 | pass |
| media manifests | single stream | brotli -q11 (+size hint) | 7,235,375 | 2,153,281 | 3.3602 | 1.0 | 441.6 | pass |
| media manifests | single stream | middle-out | 7,235,375 | 7,235,384 | 1.0000 | 1106.5 | 33692.1 | pass |
| video segments | per-segment | raw (identity) | 1,487,808 | 1,487,808 | 1.0000 | — | — | pass |
| video segments | per-segment | gzip -9 | 1,487,808 | 1,492,224 | 0.9970 | 128.0 | 3991.4 | pass |
| video segments | per-segment | brotli -q11 (+size hint) | 1,487,808 | 1,488,576 | 0.9995 | 1.0 | 3341.8 | pass |
| video segments | per-segment | middle-out | 1,487,808 | 1,489,152 | 0.9991 | 2068.6 | 7412.8 | pass |
| video segments | single stream | raw (identity) | 1,487,808 | 1,487,808 | 1.0000 | — | — | pass |
| video segments | single stream | gzip -9 | 1,487,808 | 1,488,281 | 0.9997 | 93.1 | 4374.8 | pass |
| video segments | single stream | brotli -q11 (+size hint) | 1,487,808 | 1,045,736 | 1.4227 | 1.4 | 690.5 | pass |
| video segments | single stream | middle-out | 1,487,808 | 1,487,816 | 1.0000 | 5303.3 | 16230.8 | pass |

Read honestly, per-document — the case that matters on the wire:

- **Media manifests: middle-out wins outright.** 3.0672 against brotli -q11's 2.9770 and
  gzip -9's 2.6558. This is the corpus made almost entirely of CIDs, and it is where parsing inward
  pays.
- **Protocol envelopes: middle-out beats the gzip standard, and loses to brotli -q11.** 1.4279
  against 1.3563 and 1.4925. At a mean of 1,240 bytes per document there is not much room for a
  container header plus a dictionary to amortize, and brotli's static dictionary and context
  modelling are genuinely good at small JSON. Stated plainly rather than hidden.
- **Video segments: nothing compresses them, as expected.** All four codecs sit at ~1.0 because the
  bytes are near-maximum entropy. This is the correct result, and it is exactly why Layer 1 and not
  Layer 2 is the video win.

### Weissman score

```
W = alpha * (ratio / ratio_standard) * (log(time_standard) / log(time))
```

alpha = **1**, set explicitly and never tuned. Standard is `gzip-9`, challenger is `middle-out`.
Both times are compression times in **microseconds**, the same unit for both, clamped below to 1 µs
so the logarithm stays finite and positive.

| Corpus | Mode | W | Substituted formula |
| --- | --- | --- | --- |
| protocol envelopes | per-document | 0.7269 | W = 1 x (1.4279 / 1.3563) x (ln(11455.250) / ln(756457.917)) = 0.7269 |
| protocol envelopes | single stream | 0.5940 | W = 1 x (1.0000 / 2.2869) x (ln(6269.875) / ln(624.000)) = 0.5940 |
| media manifests | per-document | 0.8693 | W = 1 x (3.0672 / 2.6558) x (ln(89470.125) / ln(3790057.417)) = 0.8693 |
| media manifests | single stream | 0.4804 | W = 1 x (1.0000 / 2.7734) x (ln(121258.042) / ln(6539.125)) = 0.4804 |
| video segments | per-segment | 1.4260 | W = 1 x (0.9991 / 0.9970) x (ln(11626.291) / ln(719.250)) = 1.4260 |
| video segments | single stream | 1.7176 | W = 1 x (1.0000 / 0.9997) x (ln(15974.250) / ln(280.542)) = 1.7176 |

Two things about this metric, so nobody reads more into it than is there. It is **unit-dependent**:
it takes the logarithm of a bare duration, so switching to milliseconds or seconds changes W. And
it **rewards speed, not only ratio** — which is why the video rows, where middle-out compresses
nothing at all, score highest. The ratio column in the table above is the number that means
something.

### Layer 1 — chunking and dedup

Chunker defaults: min 8,192 B, avg 32,768 B, max 131,072 B. `Stored bytes` is what a
content-addressed store actually holds after every source has been put into it.

| Scenario | Sources | Total bytes | Stored bytes | Chunks | Unique chunks | Dedup ratio | Bytes saved |
| --- | --- | --- | --- | --- | --- | --- | --- |
| renditions, one source per encoded segment | 192 | 1,487,808 | 1,045,440 | 199 | 160 | 1.4231 | 442,368 (29.73%) |
| renditions, one source per rendition stream | 4 | 1,487,808 | 1,456,230 | 46 | 43 | 1.0217 | 31,578 (2.12%) |
| original stream + re-upload with intro prepended | 2 | 1,184,651 | 605,353 | 36 | 19 | 1.9570 | 579,298 (48.90%) |
| everything: all renditions + the re-upload | 5 | 2,082,635 | 1,471,759 | 64 | 44 | 1.4151 | 610,876 (29.33%) |

**The insertion case.** The re-upload is the same video with 5,003 bytes of intro prepended, so
every subsequent byte is shifted by a non-multiple of any block size. How much of the re-upload is
already in the store after only the original has been stored:

| Strategy | Re-upload bytes | Blocks | Blocks already stored | Bytes already stored |
| --- | --- | --- | --- | --- |
| content-defined chunking | 594,827 | 18 | 17 (94.44%) | 579,298 (97.39%) |
| fixed-size blocking (32,768 B) | 594,827 | 19 | 0 (0.00%) | 0 (0.00%) |

**97.39% against 0.00%.** That is the whole argument for content-defined chunking in one row, and
it is the single most consequential number in this package. A re-uploaded video costs a
content-addressed network almost nothing in new storage and almost nothing in new transfer. Under
fixed-size blocking it costs full price, every time.

Note the second row of the dedup table, which cuts the other way: chunking each rendition as one
long stream finds only 2.12%, because the shared segments are smaller than the average chunk size
and the boundaries around them differ per rendition. Cross-rendition reuse wants segment-level
addressing (row 1: 29.73%); cross-*upload* reuse wants stream-level content-defined chunking
(row 3). Both are in the table because both are true.

---

## Limitations

These are the honest boundaries of the results above. The full list is in
[BENCHMARK.md](./BENCHMARK.md#what-this-does-not-prove).

- **Not a pixel codec.** No comparison to AV1/HEVC/H.264 is made or implied. Layer 1 stores what
  those codecs emit; Layer 2 compresses the metadata around it.
- **The video segments are synthetic high-entropy bytes.** They stand in for real encoded video.
  That makes them the *hard* case for the compressors — there is nothing to model, so no ratio here
  is inflated by accidentally compressible synthetic structure. But it also means the dedup ratios
  reflect the reuse pattern the generator was asked to simulate (shared stingers, mirrored rungs,
  one re-upload), not a measured distribution from a live network. Point the harness at real
  segments to get a real number.
- **The `single stream` rows deliberately flatter gzip and brotli.** Handed one concatenated
  buffer, they dedup inside their own sliding window, and brotli -q11 does: 1.4227 on the video
  corpus, close to what chunk-level dedup finds. Layer 1's difference is that it is *global and
  persistent* — a chunk stored once is never re-sent to anyone, across streams no single compressor
  window will ever hold at the same time.
- **Timings are single-machine, single-run, single-process.** Ratios reproduce exactly anywhere;
  MB/s and therefore the Weissman score do not.
- **middle-out is currently slower than zlib on the corpora it can transcode.** 0.8 MB/s on
  envelopes and 1.9 MB/s on manifests, against gzip -9's 54–128 MB/s across the whole suite.
  It is pure TypeScript against a native library and has had no optimization pass. Where bandwidth
  and storage are the scarce resources this is the right trade; where CPU is, it is not, yet.

## License

MIT
