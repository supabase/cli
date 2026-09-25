import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { useTempWorkdir } from "../../../../../tests/helpers/command-mocks.ts";
import { appendExtensionDeclarations } from "./declarative.extension-repair.ts";

describe("appendExtensionDeclarations", () => {
  const tmp = useTempWorkdir();

  it.effect("creates root extension.sql with sorted idempotent declarations", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const result = yield* appendExtensionDeclarations(tmp.current, [
        "uuid-ossp",
        "pgcrypto",
        "pgcrypto",
      ]);
      expect(result.addedExtensions).toEqual(["pgcrypto", "uuid-ossp"]);
      expect(yield* fs.readFileString(path.join(tmp.current, "extension.sql"))).toBe(
        [
          'CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";',
          'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";',
          "",
        ].join("\n"),
      );

      const repeated = yield* appendExtensionDeclarations(tmp.current, ["uuid-ossp"]);
      expect(repeated.addedDeclarations).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("preserves existing contents and CRLF newlines", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const extensionPath = path.join(tmp.current, "extension.sql");
      yield* fs.writeFileString(extensionPath, 'CREATE EXTENSION "pgcrypto";\r\n-- keep me');
      const result = yield* appendExtensionDeclarations(tmp.current, ["pgcrypto", "pg_net"]);
      expect(result.addedExtensions).toEqual(["pg_net"]);
      expect(yield* fs.readFileString(extensionPath)).toBe(
        'CREATE EXTENSION "pgcrypto";\r\n-- keep me\r\n' +
          'CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";\r\n',
      );
    }).pipe(Effect.provide(BunServices.layer));
  });
});
