import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Cause, Data, Effect, Exit, FileSystem, Option, Path, PlatformError, Schema } from "effect";
import * as Formatter from "effect/Formatter";

import { useLegacyTempWorkdir } from "../../../../tests/helpers/legacy-mocks.ts";
import { classifyCliErrorActionability } from "../../../shared/telemetry/error-actionability.ts";
import {
  LegacySsoAddMetadataFileError,
  LegacySsoUpdateAttributeMappingFileError,
} from "./sso.errors.ts";
import {
  type LegacySsoFileErrorReason,
  readAttributeMappingFile,
  readMetadataFile,
  validateMetadataXmlBytes,
} from "./sso.saml.ts";

class TestOpenError extends Data.TaggedError("TestOpenError")<{
  readonly message: string;
  readonly reason: LegacySsoFileErrorReason;
}> {}
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

function permissionDenied(method: "readFile" | "readFileString") {
  return PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor: "/private/file",
  });
}

const tempRoot = useLegacyTempWorkdir("sso-saml-unit-");
const attributeMappingFixture = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))({
  keys: { a: { name: "xyz", default: 3 } },
});

const writeTextFixture = (name: string, contents: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const file = path.join(tempRoot.current, name);
    yield* fs.writeFileString(file, contents);
    return file;
  });

const writeBytesFixture = (name: string, contents: Uint8Array) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const file = path.join(tempRoot.current, name);
    yield* fs.writeFile(file, contents);
    return file;
  });

const tempFixturePath = (name: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(tempRoot.current, name);
  });

describe("readMetadataFile", () => {
  it.live("returns the file content on UTF-8 XML", () => {
    return Effect.gen(function* () {
      const path = yield* writeTextFixture("good.xml", '<?xml version="1.0"?><md/>');
      const out = yield* readMetadata(path);
      expect(out).toBe('<?xml version="1.0"?><md/>');
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("fails with TestOpenError on missing file", () => {
    return Effect.gen(function* () {
      const path = yield* tempFixturePath("missing.xml");
      const exit = yield* Effect.exit(readMetadata(path));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Formatter.formatJson(exit.cause)).toContain("TestOpenError");
      }
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("preserves a metadata file permission failure", () => {
    const read = readMetadataFile({
      openError: (args) => new LegacySsoAddMetadataFileError(args),
      nonUtf8Error: (args) =>
        new LegacySsoAddMetadataFileError({ message: args.message, reason: "invalid_content" }),
    });
    return Effect.gen(function* () {
      const error = yield* read("/private/metadata.xml").pipe(Effect.flip);
      expect(classifyCliErrorActionability(error)).toMatchObject({
        error_kind: "user_actionable",
        error_category: "permission",
        suggestion_type: "none",
        error_fingerprint: "tag:LegacySsoAddMetadataFileError:filesystem",
      });
    }).pipe(
      Effect.provide(
        FileSystem.layerNoop({
          readFile: () => Effect.fail(permissionDenied("readFile")),
        }),
      ),
    );
  });

  it.live("fails with TestNonUtf8Error on invalid UTF-8 bytes", () => {
    return Effect.gen(function* () {
      const path = yield* writeBytesFixture("bad.xml", new Uint8Array([0xff, 0xfe, 0xfd]));
      const exit = yield* Effect.exit(readMetadata(path));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = Formatter.formatJson(exit.cause);
        expect(dump).toContain("TestNonUtf8Error");
        expect(dump).toContain("is not UTF-8 encoded");
      }
    }).pipe(Effect.provide(BunServices.layer));
  });
});

describe("readAttributeMappingFile", () => {
  it.live("parses JSON and preserves user-defined keys (e.g. `default: 3`)", () => {
    return Effect.gen(function* () {
      const path = yield* writeTextFixture("mapping.json", attributeMappingFixture);
      const parsed = yield* readAttrMapping(path);
      const root = parsed as { keys: { a: { default: number } } };
      expect(root.keys.a.default).toBe(3);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("fails with TestOpenError on malformed JSON", () => {
    return Effect.gen(function* () {
      const path = yield* writeTextFixture("bad.json", "{not json}");
      const exit = yield* Effect.exit(readAttrMapping(path));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.live("fails with TestOpenError on missing file", () => {
    return Effect.gen(function* () {
      const path = yield* tempFixturePath("nonexistent.json");
      const exit = yield* Effect.exit(readAttrMapping(path));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const dump = Formatter.formatJson(exit.cause);
        expect(dump).toContain("TestOpenError");
        expect(dump).toContain("failed to open attribute mapping");
      }
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("preserves an attribute mapping permission failure", () => {
    const read = readAttributeMappingFile({
      openError: (args) => new LegacySsoUpdateAttributeMappingFileError(args),
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(read("/private/mapping.json"));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(classifyCliErrorActionability(failure.value)).toMatchObject({
            error_kind: "user_actionable",
            error_category: "permission",
            suggestion_type: "none",
            error_fingerprint: "tag:LegacySsoUpdateAttributeMappingFileError:filesystem",
          });
        }
      }
    }).pipe(
      Effect.provide(
        FileSystem.layerNoop({
          readFileString: () => Effect.fail(permissionDenied("readFileString")),
        }),
      ),
    );
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
