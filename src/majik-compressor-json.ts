import { gzipSync, gunzipSync } from "fflate";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Accepted input shapes for create() */
export type JSONInput = Record<string, unknown> | unknown[] | string;

/** Accepted input shapes for fromMJKCJSON() */
export type MJKCJSONInput = Blob | ArrayBuffer | Uint8Array | string;

/**
 * Internal magic bytes written at the start of every MJKCJSON binary.
 * ASCII: "MJKC" → 0x4D 0x4A 0x4B 0x43
 */
const MAGIC = new Uint8Array([0x4d, 0x4a, 0x4b, 0x43]);

const MAGIC_LENGTH = MAGIC.length; // 4 bytes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uint8ToBase64(u8: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < u8.length; i += chunkSize) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const u8 = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
  return u8;
}

/** Prepend MAGIC bytes to a compressed payload. */
function frame(compressed: Uint8Array): Uint8Array {
  const framed = new Uint8Array(MAGIC_LENGTH + compressed.length);
  framed.set(MAGIC, 0);
  framed.set(compressed, MAGIC_LENGTH);
  return framed;
}

/** Strip MAGIC bytes; throws if header is invalid. */
function unframe(data: Uint8Array): Uint8Array {
  if (data.length < MAGIC_LENGTH) {
    throw new Error(
      "MajikCompressedJSON: data too short to contain magic header.",
    );
  }
  for (let i = 0; i < MAGIC_LENGTH; i++) {
    if (data[i] !== MAGIC[i]) {
      throw new Error(
        "MajikCompressedJSON: invalid magic header — not a MJKCJSON payload.",
      );
    }
  }
  return data.slice(MAGIC_LENGTH);
}

/** Normalise any accepted input to a Uint8Array. */
async function toUint8(input: MJKCJSONInput): Promise<Uint8Array> {
  if (typeof input === "string") {
    // Accept both raw base64 and data-URI style base64
    const stripped = input.includes(",") ? input.split(",")[1] : input;
    return base64ToUint8(stripped);
  }
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input instanceof Blob) {
    const buf = await input.arrayBuffer();
    return new Uint8Array(buf);
  }
  throw new Error(
    "MajikCompressedJSON: unsupported input type for fromMJKCJSON().",
  );
}

/** Parse a value that is definitely a JSON string or already an object/array. */
function parseJSON<T>(raw: unknown): T {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error("MajikCompressedJSON: input string is not valid JSON.");
    }
  }
  if (typeof raw === "object" && raw !== null) {
    return raw as T;
  }
  throw new Error(
    "MajikCompressedJSON: payload must be a JSON object, array, or JSON string.",
  );
}

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

  // -------------------------------------------------------------------------
  // Constructor (private — use create() or fromMJKCJSON())
  // -------------------------------------------------------------------------

  private constructor(payload: T, compressed: Uint8Array) {
    this.#payload = payload;
    this.#compressed = compressed;
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

    return new MajikCompressedJSON<T>(parsed, framed);
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

    return new MajikCompressedJSON<T>(payload, framed);
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
    const originalSize = new TextEncoder().encode(
      JSON.stringify(this.#payload),
    ).byteLength;
    if (originalSize === 0) return 1;
    return this.#compressed.byteLength / originalSize;
  }

  /** True if the compressed payload is empty (defensive guard). */
  get isEmpty(): boolean {
    return this.#compressed.byteLength <= MAGIC_LENGTH;
  }
}
