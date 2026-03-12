/**
 * Internal magic bytes written at the start of every MJKCJSON binary.
 * ASCII: "MJKC" → 0x4D 0x4A 0x4B 0x43
 */
export const MAGIC = new Uint8Array([0x4d, 0x4a, 0x4b, 0x43]);

export const MAGIC_LENGTH = MAGIC.length; // 4 bytes
