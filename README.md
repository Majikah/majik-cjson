# Majik CJSON

[![Developed by Zelijah](https://img.shields.io/badge/Developed%20by-Zelijah-red?logo=github&logoColor=white)](https://thezelijah.world) ![GitHub Sponsors](https://img.shields.io/github/sponsors/jedlsf?style=plastic&label=Sponsors&link=https%3A%2F%2Fgithub.com%2Fsponsors%2Fjedlsf)


**Lightweight gzip-compressed JSON container with magic-byte framing.**  
Compress, export, and restore typed JSON payloads as `Blob`, `ArrayBuffer`, or `base64` — built for Cloudflare Workers and browser environments.


![npm](https://img.shields.io/npm/v/@majikah/majik-cjson) ![npm downloads](https://img.shields.io/npm/dm/@majikah/majik-cjson) ![npm bundle size](https://img.shields.io/bundlephobia/min/%40majikah%2Fmajik-cjson) [![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0) ![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue)



```ts
const cj = MajikCompressedJSON.create({ id: 1, messages: [...] });
const blob = cj.toMJKCJSON();                                    // upload to R2
const back = await MajikCompressedJSON.decompress<MyType>(blob); // restore original
```

---

## Table of Contents
- [Majik CJSON](#majik-cjson)
  - [Table of Contents](#table-of-contents)
  - [Overview](#overview)
  - [Features](#features)
  - [Installation](#installation)
  - [Usage](#usage)
    - [Import](#import)
    - [Create a compressed container](#create-a-compressed-container)
    - [Export the compressed payload](#export-the-compressed-payload)
    - [Restore from a compressed payload](#restore-from-a-compressed-payload)
    - [High-level decompress wrapper](#high-level-decompress-wrapper)
    - [Probe without decompressing](#probe-without-decompressing)
    - [Introspection getters](#introspection-getters)
  - [API Reference](#api-reference)
    - [`MajikCompressedJSON<T>`](#majikcompressedjsont)
      - [Static methods](#static-methods)
      - [Instance methods](#instance-methods)
      - [Getters](#getters)
      - [Types](#types)
  - [Binary Format](#binary-format)
  - [Contributing](#contributing)
  - [License](#license)
  - [Author](#author)
  - [About the Developer](#about-the-developer)
  - [Contact](#contact)


---

## Overview

`majik-cjson` wraps any JSON object or array into an immutable, gzip-compressed binary container. Every payload is framed with a 4-byte magic header (`MJKC`) that allows fast identity probing without full decompression.

The container can be exported as a `Blob` (for object storage uploads), an `ArrayBuffer` (for raw binary handling), or a `base64` string (for embedding in JSON fields or URLs). Any of those forms can be fed back into `fromMJKCJSON()` to restore the original typed payload.

It is a single-dependency package (`fflate`) with no WASM, no native bindings, and no Node.js-only APIs — it runs anywhere that has `TextEncoder`, `Blob`, and `atob`/`btoa`.

---

## Features

- **gzip compression via fflate** — pure JS, no WASM, no cold-start overhead
- **Magic-byte framing** — every payload starts with `MJKC` (0x4D 0x4A 0x4B 0x43) for cheap identity probing
- **Typed generics** — full `T` support so your payload type flows through compress → decompress
- **Flexible I/O** — accepts and exports `Blob`, `ArrayBuffer`, `Uint8Array`, and `base64` strings
- **Immutable instances** — private constructor + JS `#` private fields; state is truly inaccessible at runtime
- **Input validation** — throws descriptive errors on invalid JSON, bad magic headers, and decompression failures
- **Zero Node.js dependency** — works in Cloudflare Workers, browsers, and any Web API–compatible runtime
- **Compression introspection** — `compressionRatio` and `byteSize` getters for observability

---

## Installation

```bash
npm install majik-cjson
```

```bash
pnpm add majik-cjson
```

```bash
yarn add majik-cjson
```

**Requirements:** ESM-compatible runtime with `TextEncoder`, `Blob`, `atob`/`btoa` (Cloudflare Workers, modern browsers, Node.js ≥ 18).

---

## Usage

### Import

```ts
import { MajikCompressedJSON } from "majik-cjson";
```

---

### Create a compressed container

Pass a plain object, array, or a valid JSON string. An error is thrown for invalid input.

```ts
// From an object
const cj = MajikCompressedJSON.create({ id: 1, name: "Zelijah" });

// From an array
const cj = MajikCompressedJSON.create([1, 2, 3]);

// From a JSON string
const cj = MajikCompressedJSON.create('{"id":1,"name":"Zelijah"}');

// With a custom type
type ThreadExport = { threadId: string; messages: Message[] };
const cj = MajikCompressedJSON.create<ThreadExport>(exportPayload);
```

---

### Export the compressed payload

```ts
// Blob — for uploading to Cloudflare R2 or any object store
const blob = cj.toMJKCJSON();
await r2.put("exports/thread-123.mjkcjson", blob);

// ArrayBuffer — for raw binary handling or passing directly to fetch()
const buffer = cj.toBinary();

// Base64 string — for embedding in JSON fields, database columns, or URLs
const b64 = cj.toBase64();

// Plain object with both payloads (base64-encoded compressed form)
const obj = cj.toJSON();
// → { payload: { ... }, compressed: "MJKC..." }
```

---

### Restore from a compressed payload

`fromMJKCJSON()` accepts any form — `Blob`, `ArrayBuffer`, `Uint8Array`, or `base64` string.

```ts
// From Blob (e.g. fetched from R2)
const instance = await MajikCompressedJSON.fromMJKCJSON<ThreadExport>(blob);

// From base64 string
const instance = await MajikCompressedJSON.fromMJKCJSON<ThreadExport>(b64);

// From ArrayBuffer
const instance = await MajikCompressedJSON.fromMJKCJSON<ThreadExport>(buffer);

// Access the original payload
console.log(instance.payload); // ThreadExport
```

---

### High-level decompress wrapper

If you only need the original payload and don't need the instance, use `decompress()` directly.

```ts
const original = await MajikCompressedJSON.decompress<ThreadExport>(blob);
console.log(original.threadId);
```

---

### Probe without decompressing

`isCompressed()` checks the magic header cheaply — no decompression, no JSON parsing.

```ts
const valid = await MajikCompressedJSON.isCompressed(blob); // true | false
```

Useful as a pre-flight guard before calling `fromMJKCJSON()`, e.g. when processing user-uploaded files.

---

### Introspection getters

```ts
const cj = MajikCompressedJSON.create(largePayload);

cj.payload           // T — original deserialized JSON
cj.compressedBytes   // Uint8Array — framed binary (MAGIC + gzip)
cj.byteSize          // number — byte size of compressed payload
cj.compressionRatio  // number — compressedSize / originalSize (lower = better)
cj.isEmpty           // boolean — true if compressed payload is empty

console.log(`Reduced by ${((1 - cj.compressionRatio) * 100).toFixed(1)}%`);
// → "Reduced by 87.3%"
```

---

## API Reference

### `MajikCompressedJSON<T>`

#### Static methods

| Method                                  | Description                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `create<T>(input: JSONInput)`           | Compress a JSON object, array, or JSON string. Returns a new `MajikCompressedJSON<T>` instance. |
| `fromMJKCJSON<T>(input: MJKCJSONInput)` | Reconstruct an instance from a `Blob`, `ArrayBuffer`, `Uint8Array`, or base64 string.           |
| `decompress<T>(input: MJKCJSONInput)`   | Convenience wrapper — decompresses and returns the payload directly.                            |
| `isCompressed(input: MJKCJSONInput)`    | Returns `true` if the input has a valid `MJKC` magic header. No decompression performed.        |

#### Instance methods

| Method         | Returns                              | Description                                                                                |
| -------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `toMJKCJSON()` | `Blob`                               | Framed binary as a `Blob` (`application/octet-stream`). Use for R2 / object store uploads. |
| `toBinary()`   | `ArrayBuffer`                        | Framed binary as an `ArrayBuffer`.                                                         |
| `toBase64()`   | `string`                             | Framed binary encoded as base64.                                                           |
| `toJSON()`     | `{ payload: T; compressed: string }` | Plain serialisable object with both payloads.                                              |

#### Getters

| Getter             | Type         | Description                                                                |
| ------------------ | ------------ | -------------------------------------------------------------------------- |
| `payload`          | `T`          | The original deserialized JSON payload.                                    |
| `compressedBytes`  | `Uint8Array` | The framed compressed binary.                                              |
| `byteSize`         | `number`     | Byte size of the compressed payload.                                       |
| `compressionRatio` | `number`     | `compressedSize / originalSize`. Lower is better.                          |
| `isEmpty`          | `boolean`    | `true` if the compressed payload contains no data beyond the magic header. |

#### Types

```ts
type JSONInput    = Record<string, unknown> | unknown[] | string;
type MJKCJSONInput = Blob | ArrayBuffer | Uint8Array | string;
```

---

## Binary Format

Every MJKCJSON payload follows this layout:

```
┌─────────────────────┬──────────────────────────────────────┐
│  MAGIC (4 bytes)    │  gzip-compressed JSON (variable)     │
│  4D 4A 4B 43        │  fflate gzipSync, level 6            │
│  "M" "J" "K" "C"   │                                      │
└─────────────────────┴──────────────────────────────────────┘
```

The magic header allows format detection without decompression. The gzip payload is standard RFC 1952 — compatible with any gzip implementation.

---

## Contributing

If you want to contribute or help extend support to more platforms, reach out via email. All contributions are welcome!

---

## License

[Apache-2.0](LICENSE) — free for personal and commercial use.

---

## Author

Made with 💙 by [@thezelijah](https://github.com/jedlsf)

## About the Developer

- **Developer**: Josef Elijah Fabian
- **GitHub**: [https://github.com/jedlsf](https://github.com/jedlsf)
- **Project Repository**: [https://github.com/Majikah/majik-cjson](https://github.com/Majikah/majik-cjson)

---

## Contact

- **Business Email**: [business@thezelijah.world](mailto:business@thezelijah.world)
- **Official Website**: [https://www.thezelijah.world](https://www.thezelijah.world)