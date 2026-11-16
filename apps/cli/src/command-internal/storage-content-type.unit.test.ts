import { BunPath } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect, Path } from "effect";

import { contentTypeForUpload, refineUploadContentType } from "./storage-content-type.ts";

/** Latin-1 byte view of a string fixture. */
function bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

layer(BunPath.layer)("contentTypeForUpload", (it) => {
  // `http.DetectContentType` (bytes win) then refine only generic text/plain
  // by extension via `mime.TypeByExtension`.
  it.effect("lets the sniffed bytes win over the extension (PNG named .txt)", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const png = bytes("\x89PNG\x0D\x0A\x1A\x0A\x00\x00");
      expect(contentTypeForUpload(path, png, "/x/a.txt")).toBe("image/png");
    }),
  );

  it.effect("refines a generic text/plain sniff via the file extension", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const text = bytes('{"a":1}'); // sniffs as text/plain
      expect(contentTypeForUpload(path, text, "/x/a.json")).toBe("application/json");
      expect(contentTypeForUpload(path, text, "/x/a.css")).toBe("text/css; charset=utf-8");
    }),
  );

  it.effect("is case-insensitive on the extension for the text refinement", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(contentTypeForUpload(path, bytes("plain text"), "/x/A.JSON")).toBe("application/json");
    }),
  );

  it.effect("keeps text/plain when a text file has no/unknown extension", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(contentTypeForUpload(path, bytes("plain text"), "/x/a.unknownext")).toBe(
        "text/plain; charset=utf-8",
      );
      expect(contentTypeForUpload(path, bytes("plain text"), "/x/noext")).toBe(
        "text/plain; charset=utf-8",
      );
    }),
  );

  it.effect("does not refine a non-text sniff result by extension", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const svg = bytes('<?xml version="1.0"?><svg></svg>');
      expect(contentTypeForUpload(path, svg, "/x/a.svg")).toBe("text/xml; charset=utf-8");
    }),
  );

  it.effect("falls back to application/octet-stream for unrecognized binary content", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const blob = bytes("\x00\x01\x02\x03\x04\x05garbage");
      expect(contentTypeForUpload(path, blob, "/x/a.bin")).toBe("application/octet-stream");
    }),
  );
});

layer(BunPath.layer)("refineUploadContentType", (it) => {
  it.effect("refines an explicit text/plain content-type by extension", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(refineUploadContentType(path, "text/plain", "/x/a.json")).toBe("application/json");
    }),
  );

  it.effect("leaves a non-text content-type untouched", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(refineUploadContentType(path, "image/png", "/x/a.json")).toBe("image/png");
    }),
  );
});
