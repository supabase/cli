import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { useLegacyTempWorkdir } from "../../../../../../tests/helpers/legacy-mocks.ts";
import { legacyAppendExtensionDeclarations } from "./declarative.extension-repair.ts";

describe("legacyAppendExtensionDeclarations", () => {
  const tmp = useLegacyTempWorkdir();

  it.effect("creates root extension.sql with sorted idempotent declarations", () => {
    return Effect.gen(function* () {
      const result = yield* legacyAppendExtensionDeclarations(tmp.current, [
        "uuid-ossp",
        "pgcrypto",
        "pgcrypto",
      ]);
      expect(result.addedExtensions).toEqual(["pgcrypto", "uuid-ossp"]);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      expect(yield* fs.readFileString(path.join(tmp.current, "extension.sql"))).toBe(
        [
          'CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";',
          'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";',
          "",
        ].join("\n"),
      );

      const repeated = yield* legacyAppendExtensionDeclarations(tmp.current, ["uuid-ossp"]);
      expect(repeated.addedDeclarations).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("preserves existing contents and CRLF newlines", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const extensionPath = path.join(tmp.current, "extension.sql");
      yield* fs.writeFileString(extensionPath, 'CREATE EXTENSION "pgcrypto";\r\n-- keep me');
      const result = yield* legacyAppendExtensionDeclarations(tmp.current, ["pgcrypto", "pg_net"]);
      expect(result.addedExtensions).toEqual(["pg_net"]);
      expect(yield* fs.readFileString(extensionPath)).toBe(
        'CREATE EXTENSION "pgcrypto";\r\n-- keep me\r\n' +
          'CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";\r\n',
      );
    }).pipe(Effect.provide(BunServices.layer));
  });
});
