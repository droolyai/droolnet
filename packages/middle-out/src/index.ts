/**
 * @wokenet/middle-out — the compression program behind WokeNet's decentralized video and
 * protocol layers.
 *
 * What it is. Two provable layers:
 *   1. Content-defined chunking plus global content addressing, so a chunk of media is stored
 *      and transferred once across every rendition, mirror, re-upload and edit of it that the
 *      network has ever seen. Boundaries are a function of the bytes around them, so dedup
 *      survives insertions and deletions where fixed-size blocking finds nothing.
 *   2. Typed middle-representation transcoding. Protocol envelopes and media manifests are
 *      text-encoded randomness — base58 keys, multibase digests, CIDv1 strings, decimal-string
 *      integers, exact-millisecond timestamps. Encoded randomness looks incompressible to a
 *      general-purpose compressor. Parsing inward to raw bytes, varints and dictionary
 *      references and entropy-coding outward from there recovers what it cannot.
 *
 * What it is not. It is not a pixel codec and makes no claim against AV1, HEVC or H.264 at
 * coding image data. Layer 1 stores what those codecs produce; Layer 2 compresses the metadata
 * around it. Neither one re-encodes a frame.
 *
 * Losslessness is structural, not hoped for: both `encodeMiddleOut` and `chooseEncoding` decode
 * their own output and byte-compare it against the input before returning, and fall back to
 * storing the raw bytes on any mismatch. A bug in either one can cost ratio. It cannot cost data.
 *
 * Measured results, and what they do not prove, are in BENCHMARK.md — regenerate with
 * `pnpm --filter @wokenet/middle-out bench`.
 */

/** Package version. Kept in step with `package.json` by hand; there is nothing to generate it. */
export const MIDDLE_OUT_VERSION = '0.1.0';

export * from './chunking.js';
export * from './dedup.js';
export * from './delta.js';
export * from './transcode.js';
export * from './corpus.js';
