/**
 * Layer 1 of middle-out, second half: content addressing and dedup measurement.
 *
 * `ContentAddressedStore` is an in-memory model of the network's storage layer, not a
 * cache: it exists so the dedup win of content-defined chunking can be measured on real
 * bytes, and so reassembly can be proven byte-exact. `get(put(x)) === x` is the
 * correctness proof for the whole layer — if it holds, no arrangement of chunk
 * boundaries can lose or reorder a byte.
 */

import { createHash } from 'node:crypto';
import { chunkBytes, resolveChunkingOptions, type ChunkingOptions } from './chunking.js';

/** Thrown when a manifest cannot be resolved against a store. */
export class DedupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DedupError';
  }
}

/** What `put` returns and `get` consumes: an ordered list of chunk addresses. */
export interface ChunkManifest {
  readonly digests: readonly string[];
  readonly totalBytes: number;
}

export interface DedupStats {
  /** Bytes handed to the store, counting every source. */
  readonly totalBytes: number;
  /** Bytes the store actually holds, counting each distinct chunk once. */
  readonly storedBytes: number;
  readonly totalChunks: number;
  readonly uniqueChunks: number;
  /** `totalBytes / storedBytes`, or 1 when nothing has been stored. */
  readonly dedupRatio: number;
}

/**
 * SHA-256 of `bytes` as lowercase hex.
 *
 * Hex rather than multibase, and `node:crypto` rather than a library: the digest is an
 * internal address here, and this is the fastest dependency-free option available.
 */
export function digestChunkSync(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Promise-returning form of {@link digestChunkSync}, for callers on an async path. */
export async function digestChunk(bytes: Uint8Array): Promise<string> {
  return digestChunkSync(bytes);
}

export class ContentAddressedStore {
  readonly #options: ChunkingOptions;
  readonly #blocks = new Map<string, Uint8Array>();
  #totalBytes = 0;
  #totalChunks = 0;
  #storedBytes = 0;

  /** Validates the options eagerly, so bad options throw here and not on first `put`. */
  constructor(options?: ChunkingOptions) {
    const resolved = resolveChunkingOptions(options);
    this.#options = {
      minSize: resolved.minSize,
      avgSize: resolved.avgSize,
      maxSize: resolved.maxSize,
    };
  }

  /**
   * Chunks `bytes`, stores only the chunks whose digest has not been seen, and returns
   * the manifest needed to reassemble the input exactly.
   */
  put(bytes: Uint8Array): ChunkManifest {
    const chunks = chunkBytes(bytes, this.#options);
    const digests: string[] = [];
    for (const chunk of chunks) {
      const view = bytes.subarray(chunk.offset, chunk.offset + chunk.length);
      const digest = digestChunkSync(view);
      digests.push(digest);
      if (!this.#blocks.has(digest)) {
        // `subarray` aliases the caller's buffer; the store must own its bytes so a
        // later mutation of the input cannot rewrite already-stored content.
        this.#blocks.set(digest, view.slice());
        this.#storedBytes += chunk.length;
      }
    }
    this.#totalBytes += bytes.length;
    this.#totalChunks += chunks.length;
    return { digests, totalBytes: bytes.length };
  }

  /** Reassembles the exact bytes a manifest describes. */
  get(manifest: ChunkManifest): Uint8Array {
    const out = new Uint8Array(manifest.totalBytes);
    let offset = 0;
    for (const digest of manifest.digests) {
      const block = this.#blocks.get(digest);
      if (block === undefined) {
        throw new DedupError(`store is missing chunk ${digest}`);
      }
      if (offset + block.length > out.length) {
        throw new DedupError(
          `manifest chunks overrun totalBytes (${String(manifest.totalBytes)}) at chunk ${digest}`,
        );
      }
      out.set(block, offset);
      offset += block.length;
    }
    if (offset !== manifest.totalBytes) {
      throw new DedupError(
        `manifest chunks cover ${String(offset)} bytes but declare ` +
          `${String(manifest.totalBytes)}`,
      );
    }
    return out;
  }

  has(digest: string): boolean {
    return this.#blocks.has(digest);
  }

  stats(): DedupStats {
    return {
      totalBytes: this.#totalBytes,
      storedBytes: this.#storedBytes,
      totalChunks: this.#totalChunks,
      uniqueChunks: this.#blocks.size,
      dedupRatio: this.#storedBytes === 0 ? 1 : this.#totalBytes / this.#storedBytes,
    };
  }
}

/** Puts every source into one store and reports the aggregate dedup result. */
export function measureDedup(
  sources: readonly Uint8Array[],
  options?: ChunkingOptions,
): DedupStats {
  const store = new ContentAddressedStore(options);
  for (const source of sources) {
    store.put(source);
  }
  return store.stats();
}
