import { gzipSync, gunzipSync } from "fflate";
import { JSONInput, MJKCJSONInput } from "./types";
import { frame, parseJSON, toUint8, uint8ToBase64, unframe } from "./utils";
import { MAGIC, MAGIC_LENGTH } from "./constants";

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

/**
 * Immutable compressed JSON container.
 *
 * Compression: gzip via fflate (level 6 — optimal speed/ratio balance).
 * Binary framing: 4-byte magic header "MJKC" + raw gzip payload.
 *
 * @template T  Shape of the JSON payload (defaults to Record<string, unknown>).
 *
 * @example
 * const cj = MajikCompressedJSON.create({ id: 1, messages: [...] });
 * const blob = cj.toMJKCJSON();             // upload to R2
 * const back = await MajikCompressedJSON.decompress(blob); // get original back
 */
export class MajikCompressedJSON<T = Record<string, unknown>> {
  // -------------------------------------------------------------------------
  // Private state
  // -------------------------------------------------------------------------

  /** Original deserialized payload. */
  readonly #payload: T;

  /**
   * Framed binary: MAGIC (4 bytes) + gzip-compressed JSON bytes.
   * This is the canonical on-disk / on-wire representation.
   */
  readonly #compressed: Uint8Array;

  readonly #compressionRatio: number;

  // -------------------------------------------------------------------------
  // Constructor (private — use create() or fromMJKCJSON())
  // -------------------------------------------------------------------------

  private constructor(
    payload: T,
    compressed: Uint8Array,
    originalByteLength: number,
  ) {
    this.#payload = payload;
    this.#compressed = compressed;
    this.#compressionRatio =
      originalByteLength === 0 ? 1 : compressed.byteLength / originalByteLength;
  }

  // -------------------------------------------------------------------------
  // Static factory: create from raw JSON
  // -------------------------------------------------------------------------

  /**
   * Compress a JSON object or JSON string into a MajikCompressedJSON instance.
   *
   * @param input   A plain object, array, or a valid JSON string.
   * @returns       A new MajikCompressedJSON<T> instance.
   * @throws        If the input is not a valid JSON object or array.
   */
  static create<T = Record<string, unknown>>(
    input: JSONInput,
  ): MajikCompressedJSON<T> {
    // 1. Parse + validate
    const parsed = parseJSON<T>(input);

    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(
        "MajikCompressedJSON: payload must resolve to an object or array, not a primitive.",
      );
    }

    // 2. Serialise
    let jsonString: string;
    try {
      jsonString = JSON.stringify(parsed);
    } catch (err) {
      throw new Error(
        `MajikCompressedJSON: failed to serialise payload — ${(err as Error).message}`,
      );
    }

    // 3. Compress (gzip, level 6)
    const raw = new TextEncoder().encode(jsonString);
    let gzipped: Uint8Array;
    try {
      gzipped = gzipSync(raw, { level: 6 });
    } catch (err) {
      throw new Error(
        `MajikCompressedJSON: gzip compression failed — ${(err as Error).message}`,
      );
    }

    // 4. Frame with magic header
    const framed = frame(gzipped);

    return new MajikCompressedJSON<T>(parsed, framed, raw.byteLength);
  }

  // -------------------------------------------------------------------------
  // Static factory: reconstruct from MJKCJSON blob / buffer / base64
  // -------------------------------------------------------------------------

  /**
   * Reconstruct a MajikCompressedJSON instance from a previously exported
   * MJKCJSON payload (Blob, ArrayBuffer, Uint8Array, or base64 string).
   *
   * @throws  If the magic header is invalid or decompression fails.
   */
  static async fromMJKCJSON<T = Record<string, unknown>>(
    input: MJKCJSONInput,
  ): Promise<MajikCompressedJSON<T>> {
    if (input === null || input === undefined) {
      throw new Error(
        "MajikCompressedJSON: input must not be null or undefined.",
      );
    }

    // Normalise to Uint8Array
    let framed: Uint8Array;
    try {
      framed = await toUint8(input);
    } catch (err) {
      throw new Error(
        `MajikCompressedJSON: failed to read input — ${(err as Error).message}`,
      );
    }

    // Validate magic header
    const gzipped = unframe(framed); // throws on bad header

    // Decompress
    let raw: Uint8Array;
    try {
      raw = gunzipSync(gzipped);
    } catch (err) {
      throw new Error(
        `MajikCompressedJSON: gzip decompression failed — ${(err as Error).message}`,
      );
    }

    // Deserialise
    let payload: T;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw)) as T;
    } catch (err) {
      throw new Error(
        `MajikCompressedJSON: decompressed bytes are not valid JSON — ${(err as Error).message}`,
      );
    }

    return new MajikCompressedJSON<T>(payload, framed, raw.byteLength);
  }

  // -------------------------------------------------------------------------
  // High-level convenience wrapper
  // -------------------------------------------------------------------------

  /**
   * Decompress any MJKCJSON input and return the original JSON payload directly.
   *
   * @example
   * const original = await MajikCompressedJSON.decompress<MyType>(blob);
   */
  static async decompress<T = Record<string, unknown>>(
    input: MJKCJSONInput,
  ): Promise<T> {
    const instance = await MajikCompressedJSON.fromMJKCJSON<T>(input);
    return instance.payload;
  }

  // -------------------------------------------------------------------------
  // Static probe utility
  // -------------------------------------------------------------------------

  /**
   * Cheaply check whether a value looks like a valid MJKCJSON payload
   * without fully decompressing it.
   *
   * Useful as a pre-flight guard before calling fromMJKCJSON().
   */
  static async isCompressed(input: MJKCJSONInput): Promise<boolean> {
    try {
      const u8 = await toUint8(input);
      if (u8.length < MAGIC_LENGTH) return false;
      for (let i = 0; i < MAGIC_LENGTH; i++) {
        if (u8[i] !== MAGIC[i]) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Instance export methods
  // -------------------------------------------------------------------------

  /**
   * Returns the framed binary as a Blob.
   * Use this when uploading to Cloudflare R2 or any object store.
   *
   * MIME type: "application/octet-stream"
   */
  toMJKCJSON(): Blob {
    return new Blob([this.#compressed as BlobPart], {
      type: "application/octet-stream",
    });
  }

  /**
   * Returns the framed binary as an ArrayBuffer.
   * Useful for low-level binary handling or passing to fetch() body directly.
   */
  toBinary(): ArrayBuffer {
    return this.#compressed.slice().buffer;
  }

  /**
   * Returns the framed binary encoded as a base64 string.
   * Useful for embedding in JSON fields, URL params, or clipboard.
   */
  toBase64(): string {
    return uint8ToBase64(this.#compressed);
  }

  /**
   * Returns a plain serialisable object with both payloads.
   * `compressed` is base64-encoded for JSON-safe embedding.
   */
  toJSON(): { payload: T; compressed: string } {
    return {
      payload: this.#payload,
      compressed: this.toBase64(),
    };
  }

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  /** The original deserialized JSON payload. */
  get payload(): T {
    return this.#payload;
  }

  /** The framed compressed binary (MAGIC + gzip). */
  get compressedBytes(): Uint8Array {
    return this.#compressed;
  }

  /** Byte size of the compressed (framed) payload. */
  get byteSize(): number {
    return this.#compressed.byteLength;
  }

  /**
   * Compression ratio: compressedSize / originalSize.
   * Lower is better. e.g. 0.08 means 92% size reduction.
   */
  get compressionRatio(): number {
    return this.#compressionRatio;
  }

  /** True if the compressed payload is empty (defensive guard). */
  get isEmpty(): boolean {
    return this.#compressed.byteLength <= MAGIC_LENGTH;
  }
}
