// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { MAGIC, MAGIC_LENGTH } from "./constants";
import { MJKCJSONInput } from "./types";

export function uint8ToBase64(u8: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < u8.length; i += chunkSize) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const u8 = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
  return u8;
}

/** Prepend MAGIC bytes to a compressed payload. */
export function frame(compressed: Uint8Array): Uint8Array {
  const framed = new Uint8Array(MAGIC_LENGTH + compressed.length);
  framed.set(MAGIC, 0);
  framed.set(compressed, MAGIC_LENGTH);
  return framed;
}

/** Strip MAGIC bytes; throws if header is invalid. */
export function unframe(data: Uint8Array): Uint8Array {
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
export async function toUint8(input: MJKCJSONInput): Promise<Uint8Array> {
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
export function parseJSON<T>(raw: unknown): T {
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
