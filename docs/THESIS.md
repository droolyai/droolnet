# The Middle-Out Thesis

- **Audience:** technical diligence, prospective investors, and future
  contributors
- **Status:** thesis with an implemented, measured foundation. Every number
  referenced here lives in a generated report
  (`packages/middle-out/BENCHMARK.md`, `packages/middle-out/SCALE.md`) with a
  reproduce command; this document intentionally contains no inline numbers so
  it can never drift from the measurements.
- **Last updated:** 2026-07-30

## One paragraph

Every compressor in production today — gzip, Brotli, zstd, and every video
codec — compresses each file in isolation. WokeNet's storage layer does not.
Because the network is content-addressed with a global corpus, a new upload is
compressed against everything the network already holds: identical chunks are
stored once (exact dedup), and merely *similar* chunks — renditions of the
same video, re-encodes, reused clips — are stored as verified deltas against
their nearest neighbors, found in sublinear time by a similarity index. The
consequence is an economic inversion: **storage efficiency improves as the
network grows.** Every upload enriches the corpus that makes the next upload
cheaper. A competitor can copy the algorithm in a weekend; they cannot copy
the corpus.

## The problem, s