import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Path } from "effect";
import type { DbSession } from "../../../command-internal/db-connection.service.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { genTypesGeneratorLayer } from "./types.generator.layer.ts";
import {
  type GenTypesGenerateInput,
  GenTypesGenerator,
  GenTypesToolFailedError,
  GenTypesToolNotInstalledError,
} from "./types.generator.service.ts";

const unused = (what: string) => () => Effect.die(`${what} is not part of this test`);

/** A connection whose every introspection query returns no rows: a valid, empty database. */
const emptyDatabase = Layer.succeed(DbConnection, {
  connect: () =>
    Effect.succeed<DbSession>({
      exec: unused("exec"),
      execBatch: unused("execBatch"),
      query: () => Effect.succeed([]),
      queryRaw: unused("queryRaw"),
      extensionExists: unused("extensionExists"),
      copyToCsv: unused("copyToCsv"),
    }),
});

const runtimeIn = (cwd: string) =>
  Layer.succeed(RuntimeInfo, {
    cwd,
    platform: process.platform,
    arch: process.arch,
    homeDir: cwd,
    execPath: process.execPath,
    pid: process.pid,
  });

/** The generator layer as the command wires it, with the environment the layer reads through Config. */
const layerIn = (cwd: string, env: Record<string, string>) =>
  genTypesGeneratorLayer.pipe(
    Layer.provide(emptyDatabase),
    Layer.provide(runtimeIn(cwd)),
    Layer.provide(BunServices.layer),
    Layer.provide(Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env))),
  );

const input = (lang: string): GenTypesGenerateInput => ({
  conn: {
    host: "127.0.0.1",
    port: 5432,
    user: "postgres",
    password: "postgres",
    database: "postgres",
  },
  isLocal: true,
  dnsResolver: "native",
  lang,
  includedSchemas: ["public"],
  options: {},
});

const generate = (lang: string) =>
  Effect.gen(function* () {
    const generator = yield* GenTypesGenerator;
    return yield* Effect.scoped(generator.generate(input(lang)));
  });

/** A stand-in `dart`: fails like the real tool when `.fail` sits in its cwd, else echoes its stdin. */
const FAKE_DART = `#!/bin/sh
if [ -f "$(pwd)/.fail" ]; then
  echo "The project is on Dart 3.0.0, but the generated code needs Dart 3.8.0 or newer." >&2
  exit 78
fi
printf 'args: %s\\n' "$*"
printf 'cwd: %s\\n' "$(pwd)"
cat
`;

const withFakeDart = <A, E, R>(
  body: (context: { readonly cwd: string; readonly bin: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "gen-types-dart-" }),
    );
    const bin = path.join(cwd, "bin");
    yield* fs.makeDirectory(bin);
    yield* fs.writeFileString(path.join(bin, "dart"), FAKE_DART);
    yield* fs.chmod(path.join(bin, "dart"), 0o755);
    return yield* body({ cwd, bin });
  }).pipe(Effect.provide(BunServices.layer));

describe.skipIf(process.platform === "win32")(
  "genTypesGeneratorLayer with a real subprocess",
  () => {
    it.effect("runs the language tool in the invocation directory with the document on stdin", () =>
      withFakeDart(({ cwd, bin }) =>
        generate("dart").pipe(
          Effect.tap((output) =>
            Effect.sync(() => {
              expect(output).toContain("args: run supabase_typegen --output -\n");
              expect(output).toContain(`cwd: ${cwd}\n`);
              expect(output).toContain('"schemas":[]');
              expect(output).toContain('"version":1');
            }),
          ),
          Effect.provide(layerIn(cwd, { PATH: `${bin}:/usr/bin:/bin` })),
        ),
      ),
    );

    it.effect("reports a missing toolchain with the registry's install hint", () =>
      withFakeDart(({ cwd }) =>
        Effect.flip(generate("dart")).pipe(
          Effect.tap((error) =>
            Effect.sync(() => {
              expect(error).toBeInstanceOf(GenTypesToolNotInstalledError);
              expect(error.message).toContain("Install the Dart SDK");
            }),
          ),
          Effect.provide(layerIn(cwd, { PATH: `${cwd}/nowhere:/usr/bin:/bin` })),
        ),
      ),
    );

    it.effect("surfaces the tool's stderr when it exits unsuccessfully", () =>
      withFakeDart(({ cwd, bin }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.writeFileString(path.join(cwd, ".fail"), "");
          const error = yield* Effect.flip(generate("dart"));
          expect(error).toBeInstanceOf(GenTypesToolFailedError);
          expect(error.message).toContain("exited with code 78");
          expect(error.message).toContain("needs Dart 3.8.0 or newer");
        }).pipe(
          Effect.provide(
            Layer.merge(layerIn(cwd, { PATH: `${bin}:/usr/bin:/bin` }), BunServices.layer),
          ),
        ),
      ),
    );

    it.effect("still generates in-process languages without spawning anything", () =>
      withFakeDart(({ cwd }) =>
        generate("typescript").pipe(
          Effect.tap((output) =>
            Effect.sync(() => {
              expect(output).toContain("export type Database");
            }),
          ),
          Effect.provide(layerIn(cwd, { PATH: "/usr/bin:/bin" })),
        ),
      ),
    );
  },
);
