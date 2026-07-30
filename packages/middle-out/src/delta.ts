/**
 * Layer 2 of middle-out: the verifiable delta codec.
 *
 * Every general-purpose compressor in production — gzip, brotli, zstd — compresses its input
 * in isolation. That is a reasonable assumption for a file on a disk and a wrong one for a
 * content-addressed network, which already holds a global corpus that the new upload can be
 * compressed *against*. Exact dedup catches byte-identical chunks; it catches nothing when a
 * 480p rendition, a re-encode at different settings, or a clip reused across a thousand
 * reaction videos merely *resembles* something the network holds. This file is the storage
 * primitive for that case: a chunk stored as a COPY/INSERT delta against a reference chunk.
 *
 * Two properties make the primitive safe enough to put under a storage layer:
 *
 * 1. **Verified at encode time.** {@link chooseEncoding} does not trust {@link encodeDelta}.
 *    It compresses the delta, decompresses it again, applies it, and byte-compares the result
 *    against the original target. A mismatch or a throw anywhere on that path falls back to
 *    standalone storage. Corruption is not "unlikely"; it is structurally unreachable, because
 *    a delta that does not reproduce its target is never returned.
 * 2. **Never worse than plain compression.** A delta is chosen only when the compressed delta
 *    *plus* the 32-byte reference pointer is STRICTLY smaller than the standalone brotli
 *    baseline. On high-entropy or dissimilar input the delta loses that comparison and
 *    standalone wins, so the system cannot lose to plain compression on any input.
 *
 * Nothing here uses `Math.random`, `Date.now`, or any ambient state: the same inputs always
 * produce the same bytes, which is what lets the numbers in the test suite be reproduced.
 *
 * ## Wire format: `WMOD`, version 1
 *
 * Every multi-byte integer is an unsigned LEB128 varint: little-endian 7-bit groups, high bit
 * set on every byte but the last, at most {@link MAX_VARINT_BYTES} bytes. A varint whose final
 * group is zero while a continuation byte preceded it is rejected as non-canonical, so a given
 * integer has exactly one encoding and byte-level output is reproducible.
 *
 * ```text
 * offset  size  field
 * 0       4     magic, the ASCII bytes 'W' 'M' 'O' 'D' (0x57 0x4d 0x4f 0x44)
 * 4       1     version, currently 1
 * 5       var   varint referenceLength  -- length the delta was built against, in bytes
 * -       var   varint targetLength     -- length the delta reconstructs, in bytes
 * -       ...   operations, until end of buffer
 * ```
 *
 * An operation is a tag byte followed by its operands:
 *
 * ```text
 * INSERT  0x01  varint length, then `length` literal bytes
 * COPY    0x02  varint length, varint referenceOffset
 * ```
 *
 * Zero-length operations are rejected: the encoder never emits one, so accepting them would
 * admit two encodings of the same target. Decoding validates that every COPY lies inside
 * `[0, referenceLength)`, that no operation pushes the output past `targetLength`, that the
 * operations together produce exactly `targetLength` bytes, and that `referenceLength` matches
 * the reference actually supplied. Any violation throws {@link DeltaFormatError} before a
 * single byte is read out of bounds.
 *
 * The format deliberately carries no checksum. The digest of the reconstructed chunk is the
 * checksum, and it lives in the content-addressed layer above this one, where it is already
 * being verified for every chunk regardless of how the chunk was stored.
 */

import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';

/** Thrown when a delta buffer is foreign, truncated, malformed, or paired with a bad reference. */
export class DeltaFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeltaFormatError';
  }
}

/** ASCII `WMOD`, the four bytes every delta starts with. */
export const DELTA_MAGIC = 'WMOD';

const MAGIC_BYTES = Uint8Array.of(0x57, 0x4d, 0x4f, 0x44);

/** Wire format version emitted by {@link encodeDelta} and required by {@link applyDelta}. */
export const DELTA_VERSION = 1;

/** Operation tag bytes. Exported so tools and tests can read a delta without re-deriving them. */
export const DELTA_OPS = {
  insert: 0x01,
  copy: 0x02,
} as const;

/** Longest varint accepted, which bounds any encodable length at `2 ** 49 - 1`. */
export const MAX_VARINT_BYTES = 7;

const MAX_VARINT_VALUE = 2 ** (7 * MAX_VARINT_BYTES) - 1;

/**
 * Bytes charged to a delta for naming its reference: one SHA-256 digest.
 *
 * The digest is not stored inside the delta — the caller attaches it — but it is real storage
 * the delta causes, so the never-worse comparison in {@link chooseEncoding} pays for it.
 */
export const REFERENCE_POINTER_BYTES = 32;

/** Bytes hashed to find candidate matches. Below ~12 the index degenerates into noise. */
const WINDOW_BYTES = 16;

/**
 * Shortest match worth a COPY. A COPY costs a tag byte plus two varints (4-8 bytes here), so
 * shorter matches would grow the delta; the encoder keeps them as literals instead.
 */
const MIN_MATCH_BYTES = 20;

/**
 * Candidate reference offsets examined per hash bucket.
 *
 * Highly repetitive input puts every position in one bucket; without a cap, matching would be
 * quadratic. Chains are built lowest-offset-first, so the cap keeps the 64 earliest positions,
 * which is both a good choice (earlier offsets encode as shorter varints) and a deterministic
 * one.
 */
const MAX_CANDIDATES_PER_KEY = 64;

const MIN_INDEX_BITS = 10;
const MAX_INDEX_BITS = 18;

const HASH_SEED = 0x811c_9dc5;
const HASH_PRIME = 0x0100_0193;

const EMPTY_BYTES = new Uint8Array(0);

/** Growable output buffer. Kept private so the wire format has exactly one writer. */
class ByteWriter {
  #bytes: Uint8Array;
  #length = 0;

  constructor(capacity: number) {
    this.#bytes = new Uint8Array(Math.max(capacity, 32));
  }

  pushByte(value: number): void {
    this.#reserve(1);
    this.#bytes[this.#length] = value;
    this.#length += 1;
  }

  pushBytes(chunk: Uint8Array): void {
    this.#reserve(chunk.length);
    this.#bytes.set(chunk, this.#length);
    this.#length += chunk.length;
  }

  pushVarint(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > MAX_VARINT_VALUE) {
      throw new DeltaFormatError(`cannot encode ${String(value)} as a varint`);
    }
    let remaining = value;
    while (remaining >= 0x80) {
      this.pushByte((remaining % 0x80) + 0x80);
      remaining = Math.floor(remaining / 0x80);
    }
    this.pushByte(remaining);
  }

  take(): Uint8Array {
    return this.#bytes.slice(0, this.#length);
  }

  #reserve(extra: number): void {
    const needed = this.#length + extra;
    if (needed <= this.#bytes.length) {
      return;
    }
    let capacity = this.#bytes.length * 2;
    while (capacity < needed) {
      capacity *= 2;
    }
    const grown = new Uint8Array(capacity);
    grown.set(this.#bytes.subarray(0, this.#length), 0);
    this.#bytes = grown;
  }
}

/**
 * Bounds-checked cursor over a delta buffer.
 *
 * Every read goes through {@link ByteReader.readByte}, whose `undefined` check *is* the
 * truncation check — there is no path that reads past the end and no path that returns a
 * silently-coerced zero.
 */
class ByteReader {
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.#bytes.length - this.#offset;
  }

  readByte(): number {
    const value = this.#bytes[this.#offset];
    if (value === undefined) {
      throw new DeltaFormatError(`delta is truncated: no byte at offset ${String(this.#offset)}`);
    }
    this.#offset += 1;
    return value;
  }

  readVarint(): number {
    let result = 0;
    let scale = 1;
    for (let index = 0; index < MAX_VARINT_BYTES; index += 1) {
      const byte = this.readByte();
      const payload = byte & 0x7f;
      result += payload * scale;
      if ((byte & 0x80) === 0) {
        if (index > 0 && payload === 0) {
          throw new DeltaFormatError('non-canonical varint: trailing zero group');
        }
        return result;
      }
      scale *= 0x80;
    }
    throw new DeltaFormatError(`varint longer than ${String(MAX_VARINT_BYTES)} bytes`);
  }

  readSlice(length: number): Uint8Array {
    if (length > this.remaining) {
      throw new DeltaFormatError(
        `delta is truncated: wanted ${String(length)} literal bytes, ${String(this.remaining)} remain`,
      );
    }
    const slice = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return slice;
  }
}

/**
 * Hash of the {@link WINDOW_BYTES}-byte window at `start`.
 *
 * FNV-1a over the window, then one xorshift-multiply avalanche so that masking off the low
 * bits for a bucket index still spreads. Reads past the end of `bytes` contribute zero, which
 * only happens for windows the callers already exclude.
 */
function windowHash(bytes: Uint8Array, start: number): number {
  let hash = HASH_SEED;
  for (let index = 0; index < WINDOW_BYTES; index += 1) {
    hash = (Math.imul(hash, HASH_PRIME) + (bytes[start + index] ?? 0)) >>> 0;
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x21f0_aaad) >>> 0;
  return (hash ^ (hash >>> 15)) >>> 0;
}

/**
 * Chained hash index over every window position of the reference.
 *
 * `head[bucket]` is the lowest position in that bucket and `next[position]` walks upward, so
 * candidate iteration is ascending by reference offset. That is what makes tie-breaking
 * ("lowest reference offset wins") fall out of the traversal order rather than needing a sort.
 */
interface ReferenceIndex {
  readonly head: Int32Array;
  readonly next: Int32Array;
  readonly mask: number;
}

function buildReferenceIndex(reference: Uint8Array): ReferenceIndex | null {
  const lastStart = reference.length - WINDOW_BYTES;
  if (lastStart < 0) {
    return null;
  }
  let bits = MIN_INDEX_BITS;
  while (1 << bits < lastStart + 1 && bits < MAX_INDEX_BITS) {
    bits += 1;
  }
  const head = new Int32Array(1 << bits).fill(-1);
  const next = new Int32Array(lastStart + 1).fill(-1);
  const mask = (1 << bits) - 1;
  for (let position = lastStart; position >= 0; position -= 1) {
    const bucket = windowHash(reference, position) & mask;
    next[position] = head[bucket] ?? -1;
    head[bucket] = position;
  }
  return { head, next, mask };
}

function writeHeader(writer: ByteWriter, referenceLength: number, targetLength: number): void {
  writer.pushBytes(MAGIC_BYTES);
  writer.pushByte(DELTA_VERSION);
  writer.pushVarint(referenceLength);
  writer.pushVarint(targetLength);
}

/**
 * Encode `target` as a COPY/INSERT delta against `reference`.
 *
 * Greedy, single pass, no lookahead. At each target position the window hash is looked up in
 * the reference index; each of up to {@link MAX_CANDIDATES_PER_KEY} candidates is extended
 * forward from the position and backward into the not-yet-flushed literals, and the longest
 * total match wins, lowest reference offset breaking ties. A match of at least
 * {@link MIN_MATCH_BYTES} becomes a COPY — retroactively swallowing the literals it extended
 * back over — and otherwise the position joins the pending literal run.
 *
 * The result is not minimal; no practical delta coder's is. It is deterministic, linear in
 * practice on the 32 KiB chunks this package produces, and always exactly invertible by
 * {@link applyDelta}, which is what the layers above need.
 */
export function encodeDelta(reference: Uint8Array, target: Uint8Array): Uint8Array {
  const writer = new ByteWriter(64 + Math.min(target.length, 1 << 16));
  writeHeader(writer, reference.length, target.length);

  const index = buildReferenceIndex(reference);
  let pendingStart = 0;

  if (index !== null) {
    const lastWindowStart = target.length - WINDOW_BYTES;
    let cursor = 0;
    while (cursor <= lastWindowStart) {
      const bucket = windowHash(target, cursor) & index.mask;
      let bestLength = 0;
      let bestForward = 0;
      let bestReferenceStart = 0;
      let bestTargetStart = cursor;
      let candidate = index.head[bucket] ?? -1;
      let examined = 0;

      while (candidate >= 0 && examined < MAX_CANDIDATES_PER_KEY) {
        examined += 1;
        // Extend forward. This is also what makes a hash collision harmless: a bucket hit with
        // differing bytes yields forward === 0 and is discarded below.
        let forward = 0;
        while (
          cursor + forward < target.length &&
          candidate + forward < reference.length &&
          target[cursor + forward] === reference[candidate + forward]
        ) {
          forward += 1;
        }
        if (forward > 0) {
          // Extend backward, but only over literals not yet written out.
          let backward = 0;
          while (
            cursor - backward - 1 >= pendingStart &&
            candidate - backward - 1 >= 0 &&
            target[cursor - backward - 1] === reference[candidate - backward - 1]
          ) {
            backward += 1;
          }
          const length = forward + backward;
          const referenceStart = candidate - backward;
          if (
            length > bestLength ||
            (length === bestLength && referenceStart < bestReferenceStart)
          ) {
            bestLength = length;
            bestForward = forward;
            bestReferenceStart = referenceStart;
            bestTargetStart = cursor - backward;
          }
        }
        candidate = index.next[candidate] ?? -1;
      }

      // `bestForward > 0` is not redundant with the length test: it is the guarantee that the
      // cursor advances, so this loop cannot spin.
      if (bestLength >= MIN_MATCH_BYTES && bestForward > 0) {
        if (bestTargetStart > pendingStart) {
          writer.pushByte(DELTA_OPS.insert);
          writer.pushVarint(bestTargetStart - pendingStart);
          writer.pushBytes(target.subarray(pendingStart, bestTargetStart));
        }
        writer.pushByte(DELTA_OPS.copy);
        writer.pushVarint(bestLength);
        writer.pushVarint(bestReferenceStart);
        cursor = bestTargetStart + bestLength;
        pendingStart = cursor;
      } else {
        cursor += 1;
      }
    }
  }

  if (pendingStart < target.length) {
    writer.pushByte(DELTA_OPS.insert);
    writer.pushVarint(target.length - pendingStart);
    writer.pushBytes(target.subarray(pendingStart, target.length));
  }

  return writer.take();
}

/** Callbacks {@link walkDelta} fires while validating. Every one is optional. */
interface DeltaVisitor {
  readonly targetLength?: (length: number) => void;
  readonly copy?: (referenceOffset: number, length: number) => void;
  readonly insert?: (literals: Uint8Array) => void;
}

/** What a delta says about itself, for reporting and for tests that assert op structure. */
export interface DeltaSummary {
  /** Reference length the delta was built against, as declared in the header. */
  readonly referenceLength: number;
  /** Length of the chunk the delta reconstructs, as declared in the header. */
  readonly targetLength: number;
  readonly copyOperations: number;
  readonly insertOperations: number;
  /** Target bytes supplied by COPY operations — the bytes the reference paid for. */
  readonly copiedBytes: number;
  /** Target bytes carried as literals — the bytes the delta had to spell out. */
  readonly insertedBytes: number;
  /** Size of the delta buffer itself, uncompressed. */
  readonly deltaBytes: number;
}

type DeltaWalkResult = Omit<DeltaSummary, 'deltaBytes'>;

/**
 * The single parser for the wire format: validates completely, and reports through `visitor`.
 *
 * `expectedReferenceLength` is the length of the reference the caller actually holds, or `null`
 * to accept whatever the header declares (used by {@link describeDelta}, which inspects a
 * delta without having its reference). COPY bounds are always checked against the declared
 * length, which for a non-null expectation has already been proven equal to the real one.
 */
function walkDelta(
  delta: Uint8Array,
  expectedReferenceLength: number | null,
  visitor: DeltaVisitor,
): DeltaWalkResult {
  const reader = new ByteReader(delta);
  for (const expected of MAGIC_BYTES) {
    if (reader.readByte() !== expected) {
      throw new DeltaFormatError(`not a middle-out delta: magic must be ASCII "${DELTA_MAGIC}"`);
    }
  }
  const version = reader.readByte();
  if (version !== DELTA_VERSION) {
    throw new DeltaFormatError(
      `unsupported delta version ${String(version)}, expected ${String(DELTA_VERSION)}`,
    );
  }

  const referenceLength = reader.readVarint();
  const targetLength = reader.readVarint();
  if (expectedReferenceLength !== null && referenceLength !== expectedReferenceLength) {
    throw new DeltaFormatError(
      `reference length mismatch: delta was built against ${String(referenceLength)} bytes, ` +
        `reference supplied is ${String(expectedReferenceLength)} bytes`,
    );
  }
  visitor.targetLength?.(targetLength);

  let produced = 0;
  let copyOperations = 0;
  let insertOperations = 0;
  let copiedBytes = 0;
  let insertedBytes = 0;

  while (reader.remaining > 0) {
    const tagOffset = reader.offset;
    const tag = reader.readByte();
    if (tag === DELTA_OPS.copy) {
      const length = reader.readVarint();
      const referenceOffset = reader.readVarint();
      if (length === 0) {
        throw new DeltaFormatError(`zero-length COPY at offset ${String(tagOffset)}`);
      }
      if (referenceOffset + length > referenceLength) {
        throw new DeltaFormatError(
          `COPY out of bounds: [${String(referenceOffset)}, ${String(referenceOffset + length)}) ` +
            `exceeds reference length ${String(referenceLength)}`,
        );
      }
      if (produced + length > targetLength) {
        throw new DeltaFormatError(
          `COPY overruns target: ${String(produced + length)} > ${String(targetLength)}`,
        );
      }
      visitor.copy?.(referenceOffset, length);
      produced += length;
      copyOperations += 1;
      copiedBytes += length;
    } else if (tag === DELTA_OPS.insert) {
      const length = reader.readVarint();
      if (length === 0) {
        throw new DeltaFormatError(`zero-length INSERT at offset ${String(tagOffset)}`);
      }
      if (produced + length > targetLength) {
        throw new DeltaFormatError(
          `INSERT overruns target: ${String(produced + length)} > ${String(targetLength)}`,
        );
      }
      // Read unconditionally: `visitor.insert?.(reader.readSlice(...))` would short-circuit the
      // argument when no visitor is attached and leave the cursor sitting on literal bytes.
      const literals = reader.readSlice(length);
      visitor.insert?.(literals);
      produced += length;
      insertOperations += 1;
      insertedBytes += length;
    } else {
      throw new DeltaFormatError(
        `unknown operation tag 0x${tag.toString(16).padStart(2, '0')} at offset ${String(tagOffset)}`,
      );
    }
  }

  if (produced !== targetLength) {
    throw new DeltaFormatError(
      `delta is truncated: operations produce ${String(produced)} of ${String(targetLength)} target bytes`,
    );
  }

  return {
    referenceLength,
    targetLength,
    copyOperations,
    insertOperations,
    copiedBytes,
    insertedBytes,
  };
}

/**
 * Exact inverse of {@link encodeDelta}.
 *
 * @throws {DeltaFormatError} if `delta` is foreign, truncated, non-canonical, internally
 * inconsistent, or was built against a reference of a different length than `reference`.
 */
export function applyDelta(reference: Uint8Array, delta: Uint8Array): Uint8Array {
  let out = EMPTY_BYTES;
  let produced = 0;
  walkDelta(delta, reference.length, {
    targetLength: (length) => {
      out = new Uint8Array(length);
    },
    copy: (referenceOffset, length) => {
      out.set(reference.subarray(referenceOffset, referenceOffset + length), produced);
      produced += length;
    },
    insert: (literals) => {
      out.set(literals, produced);
      produced += literals.length;
    },
  });
  return out;
}

/**
 * Parse and validate `delta` without applying it, and report its shape.
 *
 * @throws {DeltaFormatError} on any malformed delta, exactly as {@link applyDelta} would.
 */
export function describeDelta(delta: Uint8Array): DeltaSummary {
  return { ...walkDelta(delta, null, {}), deltaBytes: delta.length };
}

function compressBrotli(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(
    brotliCompressSync(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    }),
  );
}

function decompressBrotli(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(brotliDecompressSync(bytes));
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

/** Real, measured byte counts behind a {@link DeltaChoice}. Nothing here is estimated. */
export interface EncodingSizes {
  /** Uncompressed size of the chunk being stored. */
  readonly targetBytes: number;
  /** The baseline: brotli quality 11 over the chunk alone. What the network stores today. */
  readonly standaloneCompressedBytes: number;
  /** Size of the raw delta, or `null` when no reference was offered. */
  readonly deltaRawBytes: number | null;
  /** Size of the brotli-compressed delta, or `null` when no reference was offered. */
  readonly deltaCompressedBytes: number | null;
  /** `deltaCompressedBytes + REFERENCE_POINTER_BYTES`: what a delta actually costs to store. */
  readonly deltaTotalBytes: number | null;
  /** Always {@link REFERENCE_POINTER_BYTES}; recorded so a report cannot misstate it. */
  readonly referencePointerBytes: number;
  /** Whether decompress + apply + byte-compare against the target succeeded. */
  readonly deltaVerified: boolean;
  /** Bytes the chosen encoding costs, pointer included. */
  readonly chosenBytes: number;
  /** `standaloneCompressedBytes / chosenBytes`. Exactly 1 when standalone was chosen. */
  readonly improvementFactor: number;
}

/**
 * The never-worse decision.
 *
 * `delta.bytes` is the brotli-compressed delta; `standalone.bytes` is the brotli-compressed
 * chunk. `referenceDigest` exists on the delta arm only as a documented slot: the digest is
 * attached by the caller, which is the layer that knows the reference's address.
 */
export type DeltaChoice =
  | {
      readonly kind: 'delta';
      readonly bytes: Uint8Array;
      readonly referenceDigest?: never;
      readonly sizes: EncodingSizes;
    }
  | {
      readonly kind: 'standalone';
      readonly bytes: Uint8Array;
      readonly sizes: EncodingSizes;
    };

/**
 * Decide how `target` is stored, and prove the decision before returning it.
 *
 * Standalone brotli (quality 11, size hint set) is the baseline and is always computed, so it
 * is always available as the fallback. When `reference` is non-null the delta path additionally
 * runs, is compressed, and is then put through the full storage round trip — decompress, apply,
 * byte-compare — before it is eligible. The delta wins only if it is *strictly* smaller than
 * the baseline once {@link REFERENCE_POINTER_BYTES} is added.
 *
 * Two consequences worth stating plainly. On high-entropy input with a dissimilar reference the
 * delta is essentially the target wrapped in a header, so it loses and standalone is returned:
 * random bytes are incompressible and dissimilar by construction, and no corpus can fix that.
 * On a near-duplicate the delta collapses to a handful of COPY operations and wins by a large
 * factor. Both outcomes are correct; only the second is interesting.
 */
export function chooseEncoding(target: Uint8Array, reference: Uint8Array | null): DeltaChoice {
  const standalone = compressBrotli(target);

  let deltaRawBytes: number | null = null;
  let deltaCompressedBytes: number | null = null;
  let deltaTotalBytes: number | null = null;
  let deltaVerified = false;
  let verifiedDelta: Uint8Array | null = null;

  if (reference !== null) {
    const raw = encodeDelta(reference, target);
    const compressed = compressBrotli(raw);
    deltaRawBytes = raw.length;
    deltaCompressedBytes = compressed.length;
    deltaTotalBytes = compressed.length + REFERENCE_POINTER_BYTES;
    try {
      deltaVerified = bytesEqual(applyDelta(reference, decompressBrotli(compressed)), target);
    } catch {
      deltaVerified = false;
    }
    if (deltaVerified) {
      verifiedDelta = compressed;
    }
  }

  const useDelta =
    verifiedDelta !== null && deltaTotalBytes !== null && deltaTotalBytes < standalone.length;
  const chosenBytes = useDelta && deltaTotalBytes !== null ? deltaTotalBytes : standalone.length;
  const sizes: EncodingSizes = {
    targetBytes: target.length,
    standaloneCompressedBytes: standalone.length,
    deltaRawBytes,
    deltaCompressedBytes,
    deltaTotalBytes,
    referencePointerBytes: REFERENCE_POINTER_BYTES,
    deltaVerified,
    chosenBytes,
    improvementFactor: chosenBytes === 0 ? 1 : standalone.length / chosenBytes,
  };

  if (useDelta && verifiedDelta !== null) {
    return { kind: 'delta', bytes: verifiedDelta, sizes };
  }
  return { kind: 'standalone', bytes: standalone, sizes };
}

/** Reconstruct a chunk stored as a compressed delta. Inverse of the `'delta'` arm. */
export function decodeDeltaPayload(reference: Uint8Array, stored: Uint8Array): Uint8Array {
  return applyDelta(reference, decompressBrotli(stored));
}

/** Reconstruct a chunk stored standalone. Inverse of the `'standalone'` arm. */
export function decodeStandalonePayload(stored: Uint8Array): Uint8Array {
  return decompressBrotli(stored);
}

/**
 * Reconstruct whatever {@link chooseEncoding} decided.
 *
 * @throws {DeltaFormatError} if a delta-encoded chunk is decoded without its reference.
 */
export function decodeChoice(choice: DeltaChoice, reference: Uint8Array | null): Uint8Array {
  if (choice.kind === 'standalone') {
    return decodeStandalonePayload(choice.bytes);
  }
  if (reference === null) {
    throw new DeltaFormatError('cannot decode a delta-encoded chunk without its reference');
  }
  return decodeDeltaPayload(reference, choice.bytes);
}
