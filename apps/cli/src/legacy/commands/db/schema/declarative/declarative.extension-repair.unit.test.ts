import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

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
      expect(readFileSync(join(tmp.current, "extension.sql"), "utf8")).toBe(
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
    const extensionPath = join(tmp.current, "extension.sql");
    writeFileSync(extensionPath, 'CREATE EXTENSION "pgcrypto";\r\n-- keep me');
    return Effect.gen(function* () {
      const result = yield* legacyAppendExtensionDeclarations(tmp.current, ["pgcrypto", "pg_net"]);
      expect(result.addedExtensions).toEqual(["pg_net"]);
      expect(readFileSync(extensionPath, "utf8")).toBe(
        'CREATE EXTENSION "pgcrypto";\r\n-- keep me\r\n' +
          'CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";\r\n',
      );
    }).pipe(Effect.provide(BunServices.layer));
  });
});
