import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Data, Effect, Exit } from "effect";

import { useLegacyTempWorkdir } from "../../../../tests/helpers/legacy-mocks.ts";
import {
  readAttributeMappingFile,
  readMetadataFile,
  validateMetadataXmlBytes,
} from "./sso.saml.ts";

class TestOpenError extends Data.TaggedError("TestOpenError")<{ readonly message: string }> {}
class TestNonUtf8Error extends Data.TaggedError("TestNonUtf8Error")<{
  readonly source: string;
  readonly message: string;
}> {}

const readMetadata = readMetadataFile({
  openError: (args) => new TestOpenError(args),
  nonUtf8Error: (args) => new TestNonUtf8Error(args),
});

const readAttrMapping = readAttributeMappingFile({
  openError: (args) => new TestOpenError(args),
});

const tempRoot = useLegacyTempWorkdir("sso-saml-unit-");

describe("readMetadataFile", () => {
  it.live("returns the file content on UTF-8 XML", () => {
    const path = join(tempRoot.current, "good.xml");
    writeFileSync(path, '<?xml version="1.0"?><md/>');
    return Effect.gen(function* () {
      const out = yield* readMetadata(path);
      expect(out).toBe('<?xml version="1.0"?><md/>');
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("fails with TestOpenError on missing file", () => {
    const path = join(tempRoot.current, "missing.xml");
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(readMetadata(path));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("TestOpenError");
      }
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("fails with TestNonUtf8Error on invalid UTF-8 bytes", () => {
    const path = join(tempRoot.current, "bad.xml");
    writeFileSync(path, Buffer.from([0xff, 0xfe, 0xfd]));
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(readMetadata(path));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("TestNonUtf8Error");
        expect(dump).toContain("is not UTF-8 encoded");
      }
    }).pipe(Effect.provide(BunServices.layer));
  });
});

describe("readAttributeMappingFile", () => {
  it.live("parses JSON and preserves user-defined keys (e.g. `default: 3`)", () => {
    const path = join(tempRoot.current, "mapping.json");
    writeFileSync(path, JSON.stringify({ keys: { a: { name: "xyz", default: 3 } } }));
    return Effect.gen(function* () {
      const parsed = yield* readAttrMapping(path);
      const root = parsed as { keys: { a: { default: number } } };
      expect(root.keys.a.default).toBe(3);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("fails with TestOpenError on malformed JSON", () => {
    const path = join(tempRoot.current, "bad.json");
    writeFileSync(path, "{not json}");
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(readAttrMapping(path));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("fails with TestOpenError on missing file", () => {
    const path = join(tempRoot.current, "nonexistent.json");
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(readAttrMapping(path));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = JSON.stringify(exit.cause);
        expect(dump).toContain("TestOpenError");
        expect(dump).toContain("failed to open attribute mapping");
      }
    }).pipe(Effect.provide(BunServices.layer));
  });
});

describe("validateMetadataXmlBytes", () => {
  it.live("rejects 0xFF / 0xFE byte sequence as non-UTF-8", () => {
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        validateMetadataXmlBytes(
          new Uint8Array([0xff, 0xfe]),
          "test",
          (args) => new TestNonUtf8Error(args),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  it.live("accepts a UTF-8 byte sequence", () => {
    return Effect.gen(function* () {
      const result = yield* validateMetadataXmlBytes(
        new TextEncoder().encode("<xml/>"),
        "test",
        (args) => new TestNonUtf8Error(args),
      );
      expect(result).toBeUndefined();
    });
  });
});
