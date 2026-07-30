import { describe, expect, test } from 'vitest';
import {
  applyDelta,
  chooseEncoding,
  decodeChoice,
  DELTA_MAGIC,
  DELTA_OPS,
  DELTA_VERSION,
  DeltaFormatError,
  describeDelta,
  encodeDelta,
  REFERENCE_POINTER_BYTES,
} from '../src/delta.js';

/** splitmix32, inlined so every byte of test data is reproducible from this file alone. */
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

/** High-entropy bytes: the case where delta compression is *supposed* to lose. */
function pseudoRandomBytes(length: number, seed: number): Uint8Array {
  const next = splitmix32(seed);
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    out[index] = next() & 0xff;
  }
  return out;
}

/** A short pattern tiled to `length`: every 16-byte window collides, stressing the index cap. */
function repetitiveBytes(length: number, seed: number): Uint8Array {
  const pattern = pseudoRandomBytes(11, seed);
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    out[index] = pattern[index % pattern.length] ?? 0;
  }
  return out;
}

/**
 * Low-entropy, structured bytes over a 24-symbol alphabet with word-like runs.
 *
 * This stands in for the realistic case: input that plain brotli already compresses well, so a
 * delta has to beat a strong baseline rather than an incompressible one.
 */
function textLikeBytes(length: number, seed: number): Uint8Array {
  const next = splitmix32(seed);
  const alphabet = 'abcdefghijklmnopqrstuvwx';
  const out = new Uint8Array(length);
  let index = 0;
  while (index < length) {
    const wordLength = 3 + (next() % 8);
    for (let k = 0; k < wordLength && index < length; k += 1) {
      out[index] = alphabet.charCodeAt(next() % alphabet.length);
      index += 1;
    }
    if (index < length) {
      out[index] = 0x20;
      index += 1;
    }
  }
  return out;
}

/** Index of the first differing byte, or -1 when the two buffers are byte-identical. */
function firstDifference(actual: Uint8Array, expected: Uint8Array): number {
  if (actual.length !== expected.length) {
    return Math.min(actual.length, expected.length);
  }
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) {
      return index;
    }
  }
  return -1;
}

/** Encode, apply, and prove the result is the target. Returns the delta for further assertions. */
function roundTrip(reference: Uint8Array, target: Uint8Array, label: string): Uint8Array {
  const delta = encodeDelta(reference, target);
  const restored = applyDelta(reference, delta);
  expect(restored.length, `${label}: restored length`).toBe(target.length);
  expect(firstDifference(restored, target), `${label}: first differing byte`).toBe(-1);
  return delta;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Replace `Math.ceil(length * fraction)` distinct positions with different byte values. */
function substituteFraction(source: Uint8Array, fraction: number, seed: number): Uint8Array {
  const out = source.slice();
  const count = Math.ceil(source.length * fraction);
  const next = splitmix32(seed);
  const touched = new Set<number>();
  while (touched.size < count && touched.size < source.length) {
    const position = next() % source.length;
    if (touched.has(position)) {
      continue;
    }
    touched.add(position);
    out[position] = ((source[position] ?? 0) + 1 + (next() % 255)) & 0xff;
  }
  return out;
}

/**
 * An independent varint writer, so malformed-input tests do not borrow the encoder they test.
 *
 * If this and `src/delta.ts` disagreed about the encoding, the round-trip assertions below on
 * hand-built deltas would fail — which makes this a cross-check, not just a fixture helper.
 */
function writeVarintTo(out: number[], value: number): void {
  let remaining = value;
  while (remaining >= 0x80) {
    out.push((remaining % 0x80) + 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  out.push(remaining);
}

type RawOp =
  | { readonly kind: 'copy'; readonly length: number; readonly referenceOffset: number }
  | { readonly kind: 'insert'; readonly literals: readonly number[] }
  | { readonly kind: 'raw'; readonly bytes: readonly number[] };

interface RawDeltaOptions {
  readonly magic?: readonly number[];
  readonly version?: number;
  readonly referenceLength: number;
  readonly targetLength: number;
  readonly ops: readonly RawOp[];
}

function buildRawDelta(options: RawDeltaOptions): Uint8Array {
  const out: number[] = [];
  for (const byte of options.magic ?? [0x57, 0x4d, 0x4f, 0x44]) {
    out.push(byte);
  }
  out.push(options.version ?? DELTA_VERSION);
  writeVarintTo(out, options.referenceLength);
  writeVarintTo(out, options.targetLength);
  for (const op of options.ops) {
    if (op.kind === 'copy') {
      out.push(DELTA_OPS.copy);
      writeVarintTo(out, op.length);
      writeVarintTo(out, op.referenceOffset);
    } else if (op.kind === 'insert') {
      out.push(DELTA_OPS.insert);
      writeVarintTo(out, op.literals.length);
      for (const byte of op.literals) {
        out.push(byte);
      }
    } else {
      for (const byte of op.bytes) {
        out.push(byte);
      }
    }
  }
  return Uint8Array.from(out);
}

const MAGIC_LENGTH = 4;
const KIB = 1024;

interface ParsedOp {
  readonly kind: 'copy' | 'insert';
  readonly length: number;
  /** Reference offset for a COPY, or -1 for an INSERT. */
  readonly referenceOffset: number;
}

/**
 * Independent reader for the documented wire format, used to assert op *structure* — offsets and
 * ordering — that `describeDelta` deliberately aggregates away.
 */
function parseDeltaOps(delta: Uint8Array): ParsedOp[] {
  let offset = MAGIC_LENGTH + 1;
  const readVarint = (): number => {
    let result = 0;
    let scale = 1;
    for (;;) {
      const byte = delta[offset];
      if (byte === undefined) {
        throw new Error(`unexpected end of delta at ${String(offset)}`);
      }
      offset += 1;
      result += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) {
        return result;
      }
      scale *= 0x80;
    }
  };
  readVarint(); // referenceLength
  readVarint(); // targetLength
  const ops: ParsedOp[] = [];
  while (offset < delta.length) {
    const tag = delta[offset];
    offset += 1;
    if (tag === DELTA_OPS.copy) {
      const length = readVarint();
      ops.push({ kind: 'copy', length, referenceOffset: readVarint() });
    } else if (tag === DELTA_OPS.insert) {
      const length = readVarint();
      offset += length;
      ops.push({ kind: 'insert', length, referenceOffset: -1 });
    } else {
      throw new Error(`unexpected operation tag ${String(tag)} at ${String(offset - 1)}`);
    }
  }
  return ops;
}

describe('WMOD wire format', () => {
  test('every delta opens with the magic bytes and the version byte', () => {
    const reference = pseudoRandomBytes(1024, 0x0101);
    const delta = encodeDelta(reference, substituteFraction(reference, 0.02, 0x0102));
    const magic = String.fromCharCode(...Array.from(delta.subarray(0, 4)));
    expect(magic).toBe(DELTA_MAGIC);
    expect(delta[4]).toBe(DELTA_VERSION);
  });

  test('an identical reference and target collapse to a single COPY of a few bytes', () => {
    const reference = pseudoRandomBytes(32 * KIB, 0x0201);
    const delta = roundTrip(reference, reference, 'identical');
    const summary = describeDelta(delta);

    expect(summary.copyOperations).toBe(1);
    expect(summary.insertOperations).toBe(0);
    expect(summary.copiedBytes).toBe(reference.length);
    expect(summary.insertedBytes).toBe(0);
    expect(summary.referenceLength).toBe(reference.length);
    expect(summary.targetLength).toBe(reference.length);
    // header (4 magic + 1 version + 3 + 3 varints) + COPY (1 tag + 3 length + 1 offset) = 16.
    expect(delta.length).toBe(16);
    console.log(
      `[delta] identical 32 KiB chunk -> ${String(delta.length)} byte delta ` +
        `(${String(reference.length)} bytes described by 1 COPY)`,
    );
  });

  test('encoding is deterministic: the same inputs produce byte-identical deltas', () => {
    const reference = textLikeBytes(8 * KIB, 0x0301);
    const target = substituteFraction(reference, 0.03, 0x0302);
    const first = encodeDelta(reference, target);
    const second = encodeDelta(reference, target);
    expect(firstDifference(first, second)).toBe(-1);
  });

  test('describeDelta agrees with a hand-built delta from an independent writer', () => {
    const reference = pseudoRandomBytes(300, 0x0401);
    const delta = buildRawDelta({
      referenceLength: reference.length,
      targetLength: 105,
      ops: [
        { kind: 'copy', length: 100, referenceOffset: 200 },
        { kind: 'insert', literals: [1, 2, 3, 4, 5] },
      ],
    });
    const summary = describeDelta(delta);
    expect(summary.copyOperations).toBe(1);
    expect(summary.insertOperations).toBe(1);
    expect(summary.copiedBytes).toBe(100);
    expect(summary.insertedBytes).toBe(5);

    const restored = applyDelta(reference, delta);
    const expected = concatBytes(reference.subarray(200, 300), Uint8Array.of(1, 2, 3, 4, 5));
    expect(firstDifference(restored, expected)).toBe(-1);
  });
});

describe('round-trip exactness', () => {
  test('a small insertion in the middle', () => {
    const reference = pseudoRandomBytes(4 * KIB, 0x1001);
    const target = concatBytes(
      reference.subarray(0, 2000),
      pseudoRandomBytes(24, 0x1002),
      reference.subarray(2000),
    );
    const summary = describeDelta(roundTrip(reference, target, 'insertion'));
    expect(summary.copyOperations).toBe(2);
    expect(summary.insertedBytes).toBe(24);
  });

  test('a small deletion in the middle', () => {
    const reference = pseudoRandomBytes(4 * KIB, 0x1101);
    const target = concatBytes(reference.subarray(0, 1500), reference.subarray(1600));
    const summary = describeDelta(roundTrip(reference, target, 'deletion'));
    expect(summary.copyOperations).toBe(2);
    expect(summary.insertedBytes).toBe(0);
  });

  test('a single-byte substitution', () => {
    const reference = pseudoRandomBytes(4 * KIB, 0x1201);
    const target = reference.slice();
    target[2048] = ((reference[2048] ?? 0) ^ 0xff) & 0xff;
    const summary = describeDelta(roundTrip(reference, target, 'substitution'));
    expect(summary.targetLength).toBe(reference.length);
    expect(summary.insertedBytes).toBe(1);
    expect(summary.copiedBytes).toBe(reference.length - 1);
  });

  test('two transposed blocks', () => {
    const reference = pseudoRandomBytes(4 * KIB, 0x1301);
    const target = concatBytes(
      reference.subarray(0, 1000),
      reference.subarray(1200, 1400),
      reference.subarray(1000, 1200),
      reference.subarray(1400),
    );
    const delta = roundTrip(reference, target, 'transposition');
    const summary = describeDelta(delta);
    expect(summary.targetLength).toBe(reference.length);
    // Out-of-order COPYs are found because the whole reference is indexed, not just a window,
    // so a transposition costs four pointers rather than re-spelling the moved bytes.
    expect(summary.copiedBytes).toBe(reference.length);
    expect(parseDeltaOps(delta)).toEqual([
      { kind: 'copy', length: 1000, referenceOffset: 0 },
      { kind: 'copy', length: 200, referenceOffset: 1200 },
      { kind: 'copy', length: 200, referenceOffset: 1000 },
      { kind: 'copy', length: 4 * KIB - 1400, referenceOffset: 1400 },
    ]);
  });

  test('a large appended tail', () => {
    const reference = pseudoRandomBytes(8 * KIB, 0x1401);
    const tail = pseudoRandomBytes(8 * KIB, 0x1402);
    const target = concatBytes(reference, tail);
    const summary = describeDelta(roundTrip(reference, target, 'appended tail'));
    expect(summary.copyOperations).toBe(1);
    expect(summary.copiedBytes).toBe(reference.length);
    expect(summary.insertedBytes).toBe(tail.length);
  });

  test('a large prepended head', () => {
    const reference = pseudoRandomBytes(8 * KIB, 0x1501);
    const target = concatBytes(pseudoRandomBytes(4 * KIB, 0x1502), reference);
    const summary = describeDelta(roundTrip(reference, target, 'prepended head'));
    expect(summary.copiedBytes).toBe(reference.length);
  });

  test('completely unrelated random buffers still round-trip', () => {
    const reference = pseudoRandomBytes(8 * KIB, 0x1601);
    const target = pseudoRandomBytes(8 * KIB, 0x1602);
    const delta = roundTrip(reference, target, 'unrelated');
    const summary = describeDelta(delta);
    // Nothing useful is found in dissimilar high-entropy data; the delta is the target plus a
    // header. That is the honest outcome, and it is why chooseEncoding exists.
    expect(summary.insertedBytes).toBeGreaterThan(target.length - 256);
    expect(delta.length).toBeGreaterThanOrEqual(target.length);
    console.log(
      `[delta] unrelated 8 KiB buffers -> ${String(delta.length)} byte delta for ` +
        `${String(target.length)} target bytes (${String(summary.copyOperations)} COPY ops)`,
    );
  });

  test('an empty reference', () => {
    const target = pseudoRandomBytes(1000, 0x1701);
    const summary = describeDelta(roundTrip(new Uint8Array(0), target, 'empty reference'));
    expect(summary.referenceLength).toBe(0);
    expect(summary.copyOperations).toBe(0);
    expect(summary.insertedBytes).toBe(1000);
  });

  test('an empty target', () => {
    const reference = pseudoRandomBytes(1000, 0x1801);
    const delta = roundTrip(reference, new Uint8Array(0), 'empty target');
    const summary = describeDelta(delta);
    expect(summary.targetLength).toBe(0);
    expect(summary.copyOperations).toBe(0);
    expect(summary.insertOperations).toBe(0);
    expect(applyDelta(reference, delta).length).toBe(0);
  });

  test('both sides empty', () => {
    const delta = roundTrip(new Uint8Array(0), new Uint8Array(0), 'both empty');
    expect(describeDelta(delta).deltaBytes).toBe(delta.length);
  });

  test('one-byte inputs, matching and differing', () => {
    roundTrip(Uint8Array.of(7), Uint8Array.of(7), 'one byte identical');
    roundTrip(Uint8Array.of(7), Uint8Array.of(9), 'one byte differing');
    roundTrip(Uint8Array.of(7), new Uint8Array(0), 'one byte to empty');
    roundTrip(new Uint8Array(0), Uint8Array.of(7), 'empty to one byte');
  });

  test('references shorter than the hash window', () => {
    for (let length = 0; length <= 20; length += 1) {
      const reference = pseudoRandomBytes(length, 0x1900 + length);
      const target = concatBytes(reference, pseudoRandomBytes(40, 0x1980 + length));
      roundTrip(reference, target, `short reference ${String(length)}`);
      roundTrip(target, reference, `short target ${String(length)}`);
    }
  });

  test('highly repetitive inputs', () => {
    const reference = repetitiveBytes(16 * KIB, 0x1a01);
    const shifted = concatBytes(reference.subarray(5), reference.subarray(0, 5));
    const summary = describeDelta(roundTrip(reference, shifted, 'repetitive shifted'));
    expect(summary.copiedBytes).toBeGreaterThan(shifted.length - 64);

    const allZeroes = new Uint8Array(16 * KIB);
    roundTrip(allZeroes, allZeroes, 'all zeroes');
    roundTrip(allZeroes, new Uint8Array(8 * KIB), 'zeroes to shorter zeroes');
    roundTrip(reference, allZeroes, 'repetitive to zeroes');
  });

  test('a target that occurs twice in the reference resolves to the lowest offset', () => {
    const block = pseudoRandomBytes(512, 0x1b01);
    const reference = concatBytes(block, pseudoRandomBytes(64, 0x1b02), block);
    const delta = roundTrip(reference, block, 'duplicated block');
    expect(parseDeltaOps(delta)).toEqual([
      { kind: 'copy', length: block.length, referenceOffset: 0 },
    ]);
  });
});

describe('deterministic fuzzing', () => {
  /** Derive a target from a reference by a random sequence of realistic edits. */
  function mutate(reference: Uint8Array, next: () => number, editCount: number): Uint8Array {
    let current = Array.from(reference);
    for (let edit = 0; edit < editCount; edit += 1) {
      const kind = next() % 5;
      const length = current.length;
      const at = length === 0 ? 0 : next() % length;
      switch (kind) {
        case 0: {
          const runLength = 1 + (next() % 32);
          const run: number[] = [];
          for (let k = 0; k < runLength; k += 1) {
            run.push(next() & 0xff);
          }
          current.splice(at, 0, ...run);
          break;
        }
        case 1: {
          current.splice(at, 1 + (next() % 32));
          break;
        }
        case 2: {
          if (length > 0) {
            current[at] = next() & 0xff;
          }
          break;
        }
        case 3: {
          const runLength = 1 + (next() % 16);
          if (at + 2 * runLength <= current.length) {
            current = [
              ...current.slice(0, at),
              ...current.slice(at + runLength, at + 2 * runLength),
              ...current.slice(at, at + runLength),
              ...current.slice(at + 2 * runLength),
            ];
          }
          break;
        }
        case 4: {
          const runLength = 1 + (next() % 64);
          current.splice(at, 0, ...current.slice(at, at + runLength));
          break;
        }
        default:
          break;
      }
    }
    return Uint8Array.from(current);
  }

  function makeReference(flavor: number, length: number, seed: number): Uint8Array {
    if (flavor === 0) {
      return pseudoRandomBytes(length, seed);
    }
    if (flavor === 1) {
      return repetitiveBytes(length, seed);
    }
    return textLikeBytes(length, seed);
  }

  const FUZZ_CASES = 360;

  test(`${String(FUZZ_CASES)} mutated pairs all round-trip byte-exactly`, () => {
    const next = splitmix32(0xf0f0_1234);
    let totalTargetBytes = 0;
    let totalDeltaBytes = 0;
    let casesWithCopies = 0;

    for (let index = 0; index < FUZZ_CASES; index += 1) {
      const flavor = index % 3;
      const length = next() % 4097;
      const reference = makeReference(flavor, length, 0x2000 + index);
      const target = mutate(reference, next, next() % 12);
      const delta = encodeDelta(reference, target);
      const restored = applyDelta(reference, delta);

      const difference = firstDifference(restored, target);
      if (difference !== -1) {
        throw new Error(
          `fuzz case ${String(index)} (flavor ${String(flavor)}, reference ${String(length)} ` +
            `bytes, target ${String(target.length)} bytes) differs at byte ${String(difference)}`,
        );
      }
      totalTargetBytes += target.length;
      totalDeltaBytes += delta.length;
      if (describeDelta(delta).copyOperations > 0) {
        casesWithCopies += 1;
      }
    }

    expect(casesWithCopies).toBeGreaterThan(FUZZ_CASES / 2);
    console.log(
      `[delta] fuzz: ${String(FUZZ_CASES)}/${String(FUZZ_CASES)} pairs round-tripped exactly; ` +
        `${String(totalTargetBytes)} target bytes described by ${String(totalDeltaBytes)} raw ` +
        `delta bytes; ${String(casesWithCopies)} cases found at least one COPY`,
    );
  });

  test('large mutated pairs round-trip byte-exactly', () => {
    const next = splitmix32(0x0bad_c0de);
    for (let index = 0; index < 24; index += 1) {
      const flavor = index % 3;
      const length = 8 * KIB + (next() % (24 * KIB));
      const reference = makeReference(flavor, length, 0x3000 + index);
      const target = mutate(reference, next, 1 + (next() % 40));
      const restored = applyDelta(reference, encodeDelta(reference, target));
      const difference = firstDifference(restored, target);
      if (difference !== -1) {
        throw new Error(
          `large fuzz case ${String(index)} (reference ${String(length)} bytes) differs at byte ` +
            String(difference),
        );
      }
    }
  });
});

describe('malformed deltas throw DeltaFormatError', () => {
  const reference = pseudoRandomBytes(512, 0x4001);
  const target = substituteFraction(reference, 0.01, 0x4002);
  const valid = encodeDelta(reference, target);

  test('the fixture delta is itself valid', () => {
    expect(firstDifference(applyDelta(reference, valid), target)).toBe(-1);
    expect(valid.length).toBeGreaterThan(16);
  });

  test('every strict prefix of a valid delta is rejected', () => {
    for (let length = 0; length < valid.length; length += 1) {
      expect(
        () => applyDelta(reference, valid.subarray(0, length)),
        `prefix ${String(length)}`,
      ).toThrow(DeltaFormatError);
    }
  });

  test('bad magic', () => {
    const broken = valid.slice();
    broken[0] = 0x58;
    expect(() => applyDelta(reference, broken)).toThrow(DeltaFormatError);
    expect(() => applyDelta(reference, new Uint8Array(0))).toThrow(DeltaFormatError);
    expect(() => applyDelta(reference, pseudoRandomBytes(64, 0x4003))).toThrow(DeltaFormatError);
    expect(() => describeDelta(pseudoRandomBytes(256, 0x4004))).toThrow(DeltaFormatError);
  });

  test('unsupported version', () => {
    const broken = valid.slice();
    broken[4] = DELTA_VERSION + 1;
    expect(() => applyDelta(reference, broken)).toThrow(DeltaFormatError);
  });

  test('reference length mismatch', () => {
    expect(() => applyDelta(pseudoRandomBytes(511, 0x4005), valid)).toThrow(DeltaFormatError);
    expect(() => applyDelta(pseudoRandomBytes(513, 0x4006), valid)).toThrow(DeltaFormatError);
    expect(() => applyDelta(new Uint8Array(0), valid)).toThrow(DeltaFormatError);
  });

  test('COPY out of bounds', () => {
    const past = buildRawDelta({
      referenceLength: 10,
      targetLength: 5,
      ops: [{ kind: 'copy', length: 5, referenceOffset: 8 }],
    });
    expect(() => applyDelta(pseudoRandomBytes(10, 0x4007), past)).toThrow(DeltaFormatError);

    const wayPast = buildRawDelta({
      referenceLength: 10,
      targetLength: 5,
      ops: [{ kind: 'copy', length: 5, referenceOffset: 1_000_000 }],
    });
    expect(() => applyDelta(pseudoRandomBytes(10, 0x4008), wayPast)).toThrow(DeltaFormatError);
  });

  test('operations that under- or over-produce the declared target length', () => {
    const short = buildRawDelta({
      referenceLength: 10,
      targetLength: 5,
      ops: [{ kind: 'copy', length: 2, referenceOffset: 0 }],
    });
    expect(() => applyDelta(pseudoRandomBytes(10, 0x4009), short)).toThrow(DeltaFormatError);

    const long = buildRawDelta({
      referenceLength: 10,
      targetLength: 5,
      ops: [{ kind: 'copy', length: 6, referenceOffset: 0 }],
    });
    expect(() => applyDelta(pseudoRandomBytes(10, 0x400a), long)).toThrow(DeltaFormatError);

    const longInsert = buildRawDelta({
      referenceLength: 10,
      targetLength: 2,
      ops: [{ kind: 'insert', literals: [1, 2, 3] }],
    });
    expect(() => applyDelta(pseudoRandomBytes(10, 0x400b), longInsert)).toThrow(DeltaFormatError);
  });

  test('INSERT whose declared length outruns the buffer', () => {
    const truncated = buildRawDelta({
      referenceLength: 10,
      targetLength: 40,
      ops: [{ kind: 'raw', bytes: [DELTA_OPS.insert, 40, 1, 2, 3] }],
    });
    expect(() => applyDelta(pseudoRandomBytes(10, 0x400c), truncated)).toThrow(DeltaFormatError);
  });

  test('zero-length operations are not canonical', () => {
    const zeroCopy = buildRawDelta({
      referenceLength: 10,
      targetLength: 0,
      ops: [{ kind: 'copy', length: 0, referenceOffset: 0 }],
    });
    expect(() => applyDelta(pseudoRandomBytes(10, 0x400d), zeroCopy)).toThrow(DeltaFormatError);

    const zeroInsert = buildRawDelta({
      referenceLength: 10,
      targetLength: 0,
      ops: [{ kind: 'raw', bytes: [DELTA_OPS.insert, 0] }],
    });
    expect(() => applyDelta(pseudoRandomBytes(10, 0x400e), zeroInsert)).toThrow(DeltaFormatError);
  });

  test('unknown operation tags', () => {
    for (const tag of [0x00, 0x03, 0x7f, 0x80, 0xff]) {
      const garbage = buildRawDelta({
        referenceLength: 10,
        targetLength: 4,
        ops: [{ kind: 'raw', bytes: [tag, 4, 0] }],
      });
      expect(
        () => applyDelta(pseudoRandomBytes(10, 0x4010), garbage),
        `tag ${String(tag)}`,
      ).toThrow(DeltaFormatError);
    }
  });

  test('non-canonical and overlong varints', () => {
    const redundant = buildRawDelta({
      referenceLength: 10,
      targetLength: 4,
      ops: [{ kind: 'raw', bytes: [DELTA_OPS.copy, 0x84, 0x00, 0x00] }],
    });
    expect(() => applyDelta(pseudoRandomBytes(10, 0x4011), redundant)).toThrow(DeltaFormatError);

    const overlong = buildRawDelta({
      referenceLength: 10,
      targetLength: 4,
      ops: [
        {
          kind: 'raw',
          bytes: [DELTA_OPS.copy, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01],
        },
      ],
    });
    expect(() => applyDelta(pseudoRandomBytes(10, 0x4012), overlong)).toThrow(DeltaFormatError);
  });

  test('trailing garbage after a complete delta', () => {
    for (const suffix of [[0x00], [DELTA_OPS.copy], [DELTA_OPS.insert, 0x05], [0xff, 0xff]]) {
      const appended = concatBytes(valid, Uint8Array.from(suffix));
      expect(() => applyDelta(reference, appended), `suffix ${JSON.stringify(suffix)}`).toThrow(
        DeltaFormatError,
      );
    }
  });

  test('a garbled reference produces wrong bytes, never an out-of-bounds read', () => {
    // Same length, different content: apply succeeds but cannot reproduce the target. This is
    // exactly why chooseEncoding verifies rather than trusting, and why the layer above keeps
    // the chunk digest.
    const wrongReference = pseudoRandomBytes(reference.length, 0x4013);
    const restored = applyDelta(wrongReference, valid);
    expect(restored.length).toBe(target.length);
    expect(firstDifference(restored, target)).not.toBe(-1);
  });
});

describe('NEVER-WORSE guarantee', () => {
  test('KEY TEST: a 1%-mutated 32 KiB near-duplicate chooses delta and wins by a wide margin', () => {
    const reference = pseudoRandomBytes(32 * KIB, 0x5001);
    const target = substituteFraction(reference, 0.01, 0x5002);
    expect(firstDifference(target, reference)).not.toBe(-1);

    const choice = chooseEncoding(target, reference);
    const { sizes } = choice;

    console.log(
      [
        '[delta] KEY RESULT — 32 KiB chunk, 1% of bytes substituted, reference is the original:',
        `  target                     ${String(sizes.targetBytes)} B`,
        `  standalone brotli q11      ${String(sizes.standaloneCompressedBytes)} B  (baseline)`,
        `  raw delta                  ${String(sizes.deltaRawBytes)} B`,
        `  delta after brotli q11     ${String(sizes.deltaCompressedBytes)} B`,
        `  + reference pointer        ${String(sizes.referencePointerBytes)} B`,
        `  stored as ${choice.kind}       ${String(sizes.chosenBytes)} B`,
        `  improvement factor         ${sizes.improvementFactor.toFixed(2)}x vs standalone brotli`,
      ].join('\n'),
    );

    expect(choice.kind).toBe('delta');
    expect(sizes.deltaVerified).toBe(true);
    expect(sizes.chosenBytes).toBeLessThan(sizes.standaloneCompressedBytes);
    expect(sizes.improvementFactor).toBeGreaterThan(4);
    expect(firstDifference(decodeChoice(choice, reference), target)).toBe(-1);
  });

  test('unrelated random buffers always choose standalone', () => {
    for (let index = 0; index < 16; index += 1) {
      const length = 2 * KIB + index * 337;
      const reference = pseudoRandomBytes(length, 0x6000 + index);
      const target = pseudoRandomBytes(length, 0x7000 + index);
      const choice = chooseEncoding(target, reference);
      expect(choice.kind, `unrelated pair ${String(index)}`).toBe('standalone');
      expect(choice.sizes.chosenBytes).toBe(choice.sizes.standaloneCompressedBytes);
      expect(choice.sizes.improvementFactor).toBe(1);
      expect(firstDifference(decodeChoice(choice, reference), target)).toBe(-1);
    }

    const bigReference = pseudoRandomBytes(32 * KIB, 0x6100);
    const bigTarget = pseudoRandomBytes(32 * KIB, 0x7100);
    const choice = chooseEncoding(bigTarget, bigReference);
    expect(choice.kind).toBe('standalone');
    console.log(
      '[delta] unrelated 32 KiB high-entropy pair: standalone ' +
        `${String(choice.sizes.standaloneCompressedBytes)} B beats delta ` +
        `${String(choice.sizes.deltaTotalBytes)} B, so standalone is stored. Random bytes are ` +
        'incompressible and dissimilar by construction — no corpus can help here.',
    );
  });

  test('a null reference falls back to standalone and still round-trips', () => {
    const target = textLikeBytes(4 * KIB, 0x8001);
    const choice = chooseEncoding(target, null);
    expect(choice.kind).toBe('standalone');
    expect(choice.sizes.deltaRawBytes).toBeNull();
    expect(choice.sizes.deltaCompressedBytes).toBeNull();
    expect(choice.sizes.deltaTotalBytes).toBeNull();
    expect(choice.sizes.deltaVerified).toBe(false);
    expect(firstDifference(decodeChoice(choice, null), target)).toBe(-1);
  });

  test('an empty target and an empty reference choose standalone', () => {
    for (const reference of [null, new Uint8Array(0), pseudoRandomBytes(1024, 0x8101)]) {
      const choice = chooseEncoding(new Uint8Array(0), reference);
      expect(choice.kind).toBe('standalone');
      expect(decodeChoice(choice, reference).length).toBe(0);
    }
    const choice = chooseEncoding(pseudoRandomBytes(1024, 0x8102), new Uint8Array(0));
    expect(choice.kind).toBe('standalone');
  });

  test('the chosen size never exceeds the standalone baseline, across mixed inputs', () => {
    const next = splitmix32(0x9001);
    let deltaWins = 0;
    let standaloneWins = 0;

    for (let index = 0; index < 36; index += 1) {
      const flavor = index % 3;
      const length = 1 * KIB + (next() % (6 * KIB));
      const reference =
        flavor === 0
          ? pseudoRandomBytes(length, 0x9100 + index)
          : flavor === 1
            ? repetitiveBytes(length, 0x9100 + index)
            : textLikeBytes(length, 0x9100 + index);
      // Similarity sweeps from "identical" through "lightly edited" to "unrelated".
      const similarity = index % 4;
      const target =
        similarity === 0
          ? reference
          : similarity === 1
            ? substituteFraction(reference, 0.01, 0x9200 + index)
            : similarity === 2
              ? substituteFraction(reference, 0.2, 0x9200 + index)
              : pseudoRandomBytes(length, 0x9300 + index);

      const choice = chooseEncoding(target, reference);
      expect(
        choice.sizes.chosenBytes,
        `case ${String(index)} (flavor ${String(flavor)}, similarity ${String(similarity)})`,
      ).toBeLessThanOrEqual(choice.sizes.standaloneCompressedBytes);
      expect(firstDifference(decodeChoice(choice, reference), target)).toBe(-1);
      if (choice.kind === 'delta') {
        deltaWins += 1;
        expect(choice.sizes.deltaVerified).toBe(true);
        expect(choice.sizes.deltaTotalBytes).toBeLessThan(choice.sizes.standaloneCompressedBytes);
      } else {
        standaloneWins += 1;
      }
    }

    expect(deltaWins + standaloneWins).toBe(36);
    expect(deltaWins).toBeGreaterThan(0);
    console.log(
      `[delta] never-worse sweep over 36 mixed pairs: delta chosen ${String(deltaWins)}x, ` +
        `standalone chosen ${String(standaloneWins)}x, chosen size never above the baseline`,
    );
  });

  test('low-entropy near-duplicates: how delta compares against a strong brotli baseline', () => {
    const reference = textLikeBytes(32 * KIB, 0xa001);
    const target = substituteFraction(reference, 0.01, 0xa002);
    const choice = chooseEncoding(target, reference);

    console.log(
      [
        '[delta] low-entropy (24-symbol text-like) 32 KiB chunk, 1% substituted:',
        `  standalone brotli q11      ${String(choice.sizes.standaloneCompressedBytes)} B`,
        `  delta + pointer            ${String(choice.sizes.deltaTotalBytes)} B`,
        `  stored as ${choice.kind} at ${String(choice.sizes.chosenBytes)} B ` +
          `(${choice.sizes.improvementFactor.toFixed(2)}x)`,
      ].join('\n'),
    );

    expect(choice.sizes.chosenBytes).toBeLessThanOrEqual(choice.sizes.standaloneCompressedBytes);
    expect(firstDifference(decodeChoice(choice, reference), target)).toBe(-1);
  });

  test('the reference pointer overhead is charged, not waved away', () => {
    expect(REFERENCE_POINTER_BYTES).toBe(32);
    const reference = pseudoRandomBytes(16 * KIB, 0xb001);
    const choice = chooseEncoding(reference, reference);
    expect(choice.kind).toBe('delta');
    expect(choice.sizes.deltaTotalBytes).toBe(
      (choice.sizes.deltaCompressedBytes ?? 0) + REFERENCE_POINTER_BYTES,
    );
    expect(choice.sizes.chosenBytes).toBe(choice.sizes.deltaTotalBytes);
    console.log(
      `[delta] identical 16 KiB chunk against itself: ${String(choice.sizes.chosenBytes)} B ` +
        `stored (${String(choice.sizes.deltaCompressedBytes)} B delta + ` +
        `${String(REFERENCE_POINTER_BYTES)} B pointer) vs ` +
        `${String(choice.sizes.standaloneCompressedBytes)} B standalone`,
    );
  });

  test('decodeChoice refuses to decode a delta without its reference', () => {
    const reference = pseudoRandomBytes(8 * KIB, 0xc001);
    const choice = chooseEncoding(substituteFraction(reference, 0.01, 0xc002), reference);
    expect(choice.kind).toBe('delta');
    expect(() => decodeChoice(choice, null)).toThrow(DeltaFormatError);
  });
});
