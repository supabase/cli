import { BunServices } from "@effect/platform-bun";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";

import { CliConfigKeys } from "../../src/config/cli-config-keys.ts";
import { CliConfigValues } from "../../src/config/cli-config-values.service.ts";
import { withConfigEnv, withEnvVar } from "./command-mocks.ts";
import { cliConfigValuesTestLayer } from "./config-snapshot-layer.ts";
import { dbCommandConfigValuesLayer } from "./db-command-config-values.ts";
import { mockOutput } from "./mocks.ts";

const STRAY_PORT = "11111";
const AMBIENT_NAME = "SUPABASE_DB_PORT";

let previous: string | undefined;
beforeEach(() => {
  previous = process.env[AMBIENT_NAME];
  process.env[AMBIENT_NAME] = STRAY_PORT;
});
afterEach(() => {
  if (previous === undefined) delete process.env[AMBIENT_NAME];
  else process.env[AMBIENT_NAME] = previous;
});

const readDbPort = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-hermetic-layer-" });
  const snapshot = yield* CliConfigValues.use((values) =>
    values.load({ workdir, projectRef: Option.none() }),
  );
  return yield* snapshot.get(CliConfigKeys.db.port);
}).pipe(Effect.provide(BunServices.layer), Effect.scoped);

describe("hermetic config test layers", () => {
  it.live("cliConfigValuesTestLayer never reads a stray ambient SUPABASE_ variable", () =>
    readDbPort.pipe(
      Effect.provide(cliConfigValuesTestLayer),
      Effect.tap((port) =>
        Effect.sync(() => {
          expect(port.value).toBe(54322);
          expect(port.origin).toEqual({ tier: "default" });
        }),
      ),
    ),
  );

  it.live("dbCommandConfigValuesLayer never reads a stray ambient SUPABASE_ variable", () =>
    readDbPort.pipe(
      Effect.provide(dbCommandConfigValuesLayer(mockOutput().layer)),
      Effect.tap((port) =>
        Effect.sync(() => {
          expect(port.value).toBe(54322);
          expect(port.origin).toEqual({ tier: "default" });
        }),
      ),
    ),
  );

  it.live("cliConfigValuesTestLayer sees a value pinned through withConfigEnv", () =>
    withConfigEnv({ [AMBIENT_NAME]: "22222" }, readDbPort).pipe(
      Effect.provide(cliConfigValuesTestLayer),
      Effect.tap((port) =>
        Effect.sync(() => {
          expect(port.value).toBe(22222);
          expect(port.origin).toMatchObject({ tier: "shell", envName: AMBIENT_NAME });
        }),
      ),
    ),
  );

  it.live("cliConfigValuesTestLayer sees a value pinned through withEnvVar", () =>
    withEnvVar(AMBIENT_NAME, "33333", readDbPort).pipe(
      Effect.provide(cliConfigValuesTestLayer),
      Effect.tap((port) => Effect.sync(() => expect(port.value).toBe(33333))),
    ),
  );

  it.live("dbCommandConfigValuesLayer sees only the env passed to it", () =>
    readDbPort.pipe(
      Effect.provide(
        dbCommandConfigValuesLayer(mockOutput().layer, { env: { [AMBIENT_NAME]: "44444" } }),
      ),
      Effect.tap((port) =>
        Effect.sync(() => {
          expect(port.value).toBe(44444);
          expect(port.origin).toMatchObject({ tier: "shell", envName: AMBIENT_NAME });
        }),
      ),
    ),
  );
});
