# ADR-0001: Middle-Out as a Measured Compression Program

- **Status:** Accepted. The program, its layers, and its evidence rules are
  defined; no measured result is claimed by this record.
- **Date:** 2026-07-30
- **Owners:** Protocol, codec, media, and documentation
- **Scope:** `packages/middle-out`, [MIDDLE_OUT.md](../MIDDLE_OUT.md),
  [VIDEO.md](../VIDEO.md)

## Context

WokeNet's viability as a decentralized media network is an efficiency question
before it is an ideological one. Two distinct byte problems sit in the way, and
they have been repeatedly conflated — by us and by everyone else who has tried
this.

**The media problem.** A decentralized video platform pays for every stored and
transferred byte across many independent operators. Fixed-size block dedup fails
on the most common real editing operations: insert a byte and every subsequent
block boundary shifts, so a re-published edit deduplicates against nothing. Yet
re-uploads, mirrors, and re-cuts of an unchanged body are exactly where the
network's byte volume comes from.

**The protocol problem.** WokeNet's own wire data is unusually hostile to
general-purpose compressors. Canonical base58 Solana keys, `u`-prefixed
base64url digests, 59-character base32 CIDv1 strings, 160-character composite
identity URIs, decimal-string integers, and exact-millisecond RFC 3339
timestamps are high-entropy values wearing an ASCII costume. An LZ-family
compressor finds the repeated literals around them and cannot touch the encoded
randomness inside them, because from the outside that randomness is
indistinguishable from noise.

Three failure modes have to be designed against, not just avoided by good
intentions:

1. **Overclaiming.** "Middle-out" arrives with fictional baggage and an obvious
   temptation to imply a video-codec breakthrough. A single sentence comparing
   this program to AV1 or HEVC would be false, would be trivially falsified by
   anyone with a corpus, and would discredit the honest work underneath it.
2. **Silent corruption.** A grammar-aware transcoder has a large input surface.
   Test coverage cannot enumerate the inputs a real network will produce, and a
   transcoder bug that reaches production loses a creator's video permanently.
3. **Unfalsifiable numbers.** Compression results are trivially gameable through
   corpus selection, blended headline ratios, undeclared score constants, and
   unreported fallback rates. A number that cannot be reproduced is marketing.

## Decision

Adopt middle-out as a **measured program** with two layers, one structural
safety rule, and one evidence rule.

### 1. Two layers, named and bounded

| Layer | Mechanism | Applies to | Explicitly does not apply to |
| --- | --- | --- | --- |
| **Layer 1** | Content-defined chunking with a rolling hash, plus global dedup by content address | Media segments, re-uploads, mirrors, edited re-publishes | Anything where the bytes are not genuinely identical, including two renditions of one source |
| **Layer 2** | Inward parse to a typed middle representation (raw bytes, varints, dictionary refs, structural tags), then outward entropy coding | On-chain references, indexer projection state, relay frames, media manifests and playlists, captions | Already-compressed media segment bytes, which are passed through |

Layer 1 and Layer 2 are never blended into one number. Each is measured on its
own families.

### 2. Middle-out reproduces exact bytes, not equivalent documents

The transcoder is a bijection over byte sequences, not a semantic normalizer. It
may not reorder keys, normalize Unicode, drop unknown fields, canonicalize
whitespace, or re-render numbers, even where the result would be semantically
identical. WokeNet signatures cover exact canonical bytes, so a semantically
equivalent output would be a cryptographically invalid one.

### 3. Losslessness is structural, not hoped for

At encode time, after producing candidate output, the encoder decodes its own
candidate and compares the result byte-for-byte against the exact input. On any
mismatch, and on any thrown error anywhere in the transcode path, the encoder
discards the candidate and emits a **passthrough container** holding the raw
bytes behind a mode flag.

Consequences of this rule, which are the reason for it:

- A transcoder bug can cost compression ratio. It cannot cost fidelity.
- The trusted surface shrinks from "the whole transcoder" to two small, total,
  directly testable primitives: the container framing and the byte comparison.
- The codec is therefore safe to deploy while the transcoder is young, which is
  the only way a grammar-aware codec ever gets to grow up.

Supporting requirements: a format version in the container; committed golden
vectors pinning historical bytes to their expected decode, so a future decoder
change that would reinterpret old data fails a test rather than a user; and
deterministic encoding — no `Date.now()`, no `Math.random()` in library code or
corpora.

### 4. No claim without a reproducible score

No efficiency claim about middle-out may be made anywhere — repository,
documentation, README, marketing, or conversation — unless all of the following
hold:

1. The corpus is committed to this repository, deterministically generated from
   fixed seeds where synthetic, and referenced by commit and digest.
2. The corpus includes adversarial families: already-compressed bytes, encrypted
   bytes, empty input, single-byte input, threshold boundaries, and valid inputs
   the transcoder does not understand.
3. Baselines include raw, gzip level 9, and brotli quality 11, plus zstd at
   maximum level if the pinned Node exposes it through `node:zlib`. The report
   names the baselines it actually ran, and the claim is stated only against
   those.
4. Every corpus item round-trips byte-exact under the harness's own comparison,
   not the encoder's. Any failure produces **no score**, not a lower one.
5. **Passthrough rate is reported per family.** A ratio without it is
   uninterpretable, since a codec that falls back on everything is perfectly
   lossless and perfectly useless.
6. Results are reported per family. There is no blended headline ratio, because
   a blended number is movable by changing the family mix.
7. A Weissman score is reported only with a declared **alpha = 1.0**, a declared
   reference codec (gzip level 9), a declared time unit (seconds), and only for
   families where both codecs exceed one second of compression time — because
   `ln T` is negative below one second and silently inverts the score. Decode
   throughput is reported separately and the score is never the only number.
8. The report is generated by the harness, never hand-edited, and lives at
   `packages/middle-out/BENCHMARK.md`, reproducible by
   `pnpm --filter @wokenet/middle-out bench`.

### 5. Claims that are permanently out of bounds

- Any comparison of middle-out to AV1, HEVC, AVC, VVC, or any pixel codec.
  Middle-out does not encode pixels; the comparison is a category error.
- Any claim that middle-out beats "general-purpose compression" in the abstract,
  rather than beating the named baselines on the named corpus.
- Any claim that decentralized storage uses fewer total bytes than a centralized
  service. Replication factor *k* stores *k* copies; whether dedup outruns
  replication is an unanswered arithmetic question about real corpora.
- Any energy, joule, or CO₂e figure. Fewer bytes is a sound mechanism; a figure
  requires a methodology and hardware data that do not exist here.
- Any field-level arithmetic ceiling quoted as a compression result. The ceiling
  table in [MIDDLE_OUT.md](../MIDDLE_OUT.md#field-level-arithmetic-ceilings) is
  derivable arithmetic, labelled as such, and is not evidence.

### 6. Roadmap items are hypotheses until measured

Dictionary training, delta-encoded playlists, seek-aware segment ordering,
hardware-aware deterministic encode ladders, transport framing, CDC parameter
search, caption transcoding, and thumbnail sprite dedup are recorded as
hypotheses with a stated falsification condition each. A hypothesis is promoted
by exactly one thing: a committed harness result on the public corpus.

## Consequences

### Benefits

- The efficiency argument that decentralized media economics depends on becomes
  falsifiable, which is the only form in which it is worth anything.
- The codec can ship early. The round-trip gate means the worst outcome of an
  immature transcoder is a wasted CPU cycle and a ratio of 1.0.
- The two layers can be developed, measured, and reasoned about independently,
  and neither can borrow the other's results.
- The dedup story stops being vague. The honest table in
  [MIDDLE_OUT.md](../MIDDLE_OUT.md) separates the cases where bytes are truly
  identical from the cases where implying dedup would be a lie — most notably
  across renditions, where there is no win at all.
- Reviewers, users, and outside engineers can check us. Every number has a
  command.

### Costs and risks

- **Encode cost roughly doubles**, because every encode also decodes and
  compares. This is a real cost and it appears in the benchmark's timing
  columns, not in a footnote.
- **Layer 2 requires a strict, maintained parser per grammar.** Every protocol
  schema change is a codec change, and a grammar the parser has not learned
  simply passes through.
- **CDC parameters are protocol-visible constants.** Changing the window
  function, mask width, or size clamps changes every chunk boundary and
  therefore every chunk address. They must be frozen from measured results, not
  tuned casually.
- **Chunk-count overhead and request amplification are real.** Smaller chunks
  dedup better and cost more index entries, manifest bytes, and round trips.
  Bytes saved is not time saved.
- **Convergent addressing enables confirmation-of-file attacks.** Public
  boundary functions are appropriate for public media and inappropriate for
  private content.
- **Dedup is in tension with deletion.** A chunk referenced by two manifests
  survives unpinning one of them. This is documented in
  [VIDEO.md](../VIDEO.md#dedup-and-deletion-are-in-tension) rather than
  discovered later, and the encryption-versus-dedup choice is an open gate.
- **The evidence rule is slow on purpose.** It forbids the fastest possible
  announcement and will feel like friction whenever a favourable early number
  appears.

## Rejected alternatives

- **Wrap gzip or brotli and call it middle-out.** Honest about its behavior and
  pointless: it recovers none of the encoded randomness that motivates Layer 2
  and adds a container for no gain.
- **Claim or imply a video-codec win.** False, trivially falsified by anyone with
  a corpus and `ffmpeg`, and fatal to every honest claim standing next to it.
- **Rely on test coverage for losslessness instead of an encode-time gate.**
  Coverage cannot enumerate the inputs a real network produces. The failure mode
  is a permanently corrupted creator upload, which is not an acceptable price
  for a marginally faster encoder.
- **Fixed-size block dedup.** Fails under insertion and deletion, which is the
  common case for republished media, and the failure is total rather than
  gradual.
- **Store renditions as monolithic files with no chunking.** Forfeits dedup
  across re-uploads, mirrors, and edits — the entire Layer-1 thesis.
- **Semantic normalization before compression** (key reordering, Unicode
  normalization, dropping unknown fields). Would produce bytes that no longer
  match the signed canonical form, destroying verifiability to save a few bytes.
- **Deduplicate private content with the public boundary function.** Trades a
  storage saving for a confirmation-of-file oracle against private data.
- **Publish a single blended headline ratio.** Movable to any desired value by
  reweighting the corpus, and therefore not a measurement.
- **Publish a Weissman score without a declared alpha and reference codec.**
  Alpha is a free normalization constant; without it the score is not a number.
- **Add a native compression dependency** (zstd bindings, custom-dictionary
  brotli libraries). The dependency budget is `bs58` plus Node builtins;
  native additions expand supply-chain and build surface for a baseline that
  `node:zlib` may already provide.
- **Train and ship a dictionary now on the strength of the argument.** The
  argument is good and the result is unmeasured; it stays a hypothesis with a
  falsification condition.

## Evidence and status language

**May be described as evidence:** local `vitest` suites in
`packages/middle-out`; round-trip and determinism property tests; committed
golden vectors; and the contents of a harness-generated
`packages/middle-out/BENCHMARK.md`, quoted with its corpus commit, baseline
list, passthrough rates, and recorded machine.

**May not be described as evidence:** anything in
[MIDDLE_OUT.md](../MIDDLE_OUT.md) or [VIDEO.md](../VIDEO.md), which are design
documents; the arithmetic ceiling table; a benchmark run that has not been
committed; a number remembered from a previous run; any comparison to a pixel
codec; any energy figure; any claim about the storage network, gateway layer, or
player, none of which exist.

**Status language that must be preserved:** middle-out is a program with a
defined measurement contract and an implemented subset bounded by
`packages/middle-out`'s committed source and tests. It is not a shipped codec, a
deployed network, or a demonstrated efficiency advantage until a committed
harness result says so.

## References

- [MIDDLE_OUT.md](../MIDDLE_OUT.md) — program definition, layer boundaries,
  field arithmetic, measurement contract, roadmap hypotheses.
- [VIDEO.md](../VIDEO.md) — the decentralized video platform this program
  serves, including the dedup-versus-deletion tension.
- [DECENTRALIZED_SOVEREIGNTY.md](../DECENTRALIZED_SOVEREIGNTY.md) — build-order
  gate 3, "prove the efficiency moat."
- `packages/middle-out/BENCHMARK.md` — the only location for measured results.
- The WokeSocial repository's `docs/PROTOCOL.md` (canonical serialization,
  identifier encodings, content addressing) and
  `docs/DECISIONS/0002-canonical-serialization-and-hashing.md` (why exact bytes
  are the signed bytes).
