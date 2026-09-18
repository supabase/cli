import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Cause, Data, Effect, Exit, FileSystem, Option, Path, PlatformError } from "effect";

import { useTempWorkdir } from "../../../tests/helpers/command-mocks.ts";
import { classifyCliErrorActionability } from "../../shared/telemetry/error-actionability.ts";
import { SsoAddMetadataFileError, SsoUpdateAttributeMappingFileError } from "./sso.errors.ts";
import {
  type SsoFileErrorReason,
  readAttributeMappingFile,
  readMetadataFile,
  validateMetadataXmlBytes,
} from "./sso.saml.ts";

class TestOpenError extends Data.TaggedError("TestOpenError")<{
  readonly message: string;
  readonly reason: SsoFileErrorReason;
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

const tempRoot = useTempWorkdir("sso-saml-unit-");

describe("readMetadataFile", () => {
  it.live("returns the file content on UTF-8 XML", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const path = pathService.join(tempRoot.current, "good.xml");
      yield* fs.writeFileString(path, '<?xml version="1.0"?><md/>');
      return yield* Effect.gen(function* () {
        const out = yield* readMetadata(path);
        expect(out).toBe('<?xml version="1.0"?><md/>');
      }).pipe(Effect.provide(BunServices.layer));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails with TestOpenError on missing file", () =>
    Effect.gen(function* () {
      const pathService = yield* Path.Path;
      const path = pathService.join(tempRoot.current, "missing.xml");
      return yield* Effect.gen(function* () {
        const exit = yield* Effect.exit(readMetadata(path));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("TestOpenError");
        }
      }).pipe(Effect.provide(BunServices.layer));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("preserves a metadata file permission failure", () => {
    const read = readMetadataFile({
      openError: (args) => new SsoAddMetadataFileError(args),
      nonUtf8Error: (args) =>
        new SsoAddMetadataFileError({ message: args.message, reason: "invalid_content" }),
    });
    return Effect.gen(function* () {
      const error = yield* read("/private/metadata.xml").pipe(Effect.flip);
      expect(classifyCliErrorActionability(error)).toMatchObject({
        error_kind: "user_actionable",
        error_category: "permission",
        suggestion_type: "none",
        error_fingerprint: "tag:SsoAddMetadataFileError:filesystem",
      });
    }).pipe(
      Effect.provide(
        FileSystem.layerNoop({
          readFile: () => Effect.fail(permissionDenied("readFile")),
        }),
      ),
    );
  });

  it.live("fails with TestNonUtf8Error on invalid UTF-8 bytes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const path = pathService.join(tempRoot.current, "bad.xml");
      yield* fs.writeFile(path, Buffer.from([0xff, 0xfe, 0xfd]));
      return yield* Effect.gen(function* () {
        const exit = yield* Effect.exit(readMetadata(path));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = Cause.pretty(exit.cause);
          expect(dump).toContain("TestNonUtf8Error");
          expect(dump).toContain("is not UTF-8 encoded");
        }
      }).pipe(Effect.provide(BunServices.layer));
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("readAttributeMappingFile", () => {
  it.live("parses JSON and preserves user-defined keys (e.g. `default: 3`)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const path = pathService.join(tempRoot.current, "mapping.json");
      yield* fs.writeFileString(path, '{ "keys": { "a": { "name": "xyz", "default": 3 } } }');
      return yield* Effect.gen(function* () {
        const parsed = yield* readAttrMapping(path);
        expect(parsed).toMatchObject({ keys: { a: { default: 3 } } });
      }).pipe(Effect.provide(BunServices.layer));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails with TestOpenError on malformed JSON", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const path = pathService.join(tempRoot.current, "bad.json");
      yield* fs.writeFileString(path, "{not json}");
      return yield* Effect.gen(function* () {
        const exit = yield* Effect.exit(readAttrMapping(path));
        expect(Exit.isFailure(exit)).toBe(true);
      }).pipe(Effect.provide(BunServices.layer));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("fails with TestOpenError on missing file", () =>
    Effect.gen(function* () {
      const pathService = yield* Path.Path;
      const path = pathService.join(tempRoot.current, "nonexistent.json");
      return yield* Effect.gen(function* () {
        const exit = yield* Effect.exit(readAttrMapping(path));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const dump = Cause.pretty(exit.cause);
          expect(dump).toContain("TestOpenError");
          expect(dump).toContain("failed to open attribute mapping");
        }
      }).pipe(Effect.provide(BunServices.layer));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("preserves an attribute mapping permission failure", () => {
    const read = readAttributeMappingFile<SsoUpdateAttributeMappingFileError>({
      openError: (args) => new SsoUpdateAttributeMappingFileError(args),
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(read("/private/mapping.json"));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error)).toBe(true);
        if (Option.isSome(error)) {
          expect(classifyCliErrorActionability(error.value)).toMatchObject({
            error_kind: "user_actionable",
            error_category: "permission",
            suggestion_type: "none",
            error_fingerprint: "tag:SsoUpdateAttributeMappingFileError:filesystem",
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
