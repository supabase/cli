import { BunServices } from "@effect/platform-bun";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Option,
  Path,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { afterAll, expect, test } from "vitest";
import {
  makeTempCliProject,
  makeTempHome,
  runSupabase,
  spawnSupabase,
} from "../../../../tests/helpers/cli.ts";
import { openStack, StackIdSchema } from "@supabase/stack/effect";

const host = ManagedRuntime.make(Layer.merge(BunServices.layer, FetchHttpClient.layer));
afterAll(() => host.dispose());
const statusSchema = Schema.fromJsonString(
  Schema.Struct({
    endpoints: Schema.Struct({ api: Schema.Struct({ url: Schema.String }) }),
    instances: Schema.Array(Schema.Struct({ service: Schema.String, phase: Schema.String })),
  }),
);
const stackIdentitySchema = Schema.fromJsonString(
  Schema.Struct({ identity: Schema.Struct({ id: StackIdSchema }) }),
);

test.each(["native", "container"] as const)(
  "keeps managed Functions available after the serving CLI exits without starting PostgreSQL (%s)",
  { timeout: 240_000 },
  async (runtime) => {
    const home = makeTempHome();
    const project = await makeTempCliProject("supabase-functions-client-");
    const options = { cwd: project.dir, home: home.dir, env: { SUPABASE_EXPERIMENTAL_STACK: "1" } };
    await host.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const functions = path.join(project.dir, "supabase", "functions", "hello");
        const external = path.join(project.dir, "external");
        yield* fs.makeDirectory(functions, { recursive: true });
        yield* fs.makeDirectory(external, { recursive: true });
        yield* fs.writeFileString(
          path.join(project.dir, "supabase", "config.toml"),
          [
            'project_id = "functions-client"',
            "[experimental]",
            "stack = true",
            "[functions.external]",
            "verify_jwt = false",
            'entrypoint = "../external/index.ts"',
            'import_map = "../external/deno.json"',
            'static_files = ["../external/asset.txt"]',
            "",
          ].join("\n"),
        );
        yield* fs.writeFileString(
          path.join(functions, "index.ts"),
          'Deno.serve(() => new Response("still-serving"));\n',
        );
        yield* fs.writeFileString(
          path.join(external, "deno.json"),
          '{"imports":{"external-helper":"./helper.ts"}}\n',
        );
        yield* fs.writeFileString(
          path.join(external, "helper.ts"),
          'export const externalMessage = "external-helper";\n',
        );
        yield* fs.writeFileString(path.join(external, "asset.txt"), "external-asset\n");
        yield* fs.writeFileString(
          path.join(external, "index.ts"),
          [
            'import { externalMessage } from "external-helper";',
            "",
            "Deno.serve(async () =>",
            '  new Response(`${externalMessage}:${await Deno.readTextFile(new URL("./asset.txt", import.meta.url))}`),',
            ");",
            "",
          ].join("\n"),
        );
      }),
    );
    let serving: ReturnType<typeof spawnSupabase> | undefined;
    let functionsReady: Promise<unknown> | undefined;
    const failures: unknown[] = [];
    try {
      const prepared = await runSupabase(
        [
          "stack",
          "prepare",
          "--runtime",
          runtime === "container" ? "docker" : "native",
          "--capability",
          "functions",
        ],
        { ...options, exitTimeoutMs: 180_000 },
      );
      expect(prepared.exitCode, prepared.stderr).toBe(0);
      const preparedStatus = await runSupabase(
        ["stack", "status", "--output-format", "json"],
        options,
      );
      expect(preparedStatus.exitCode, preparedStatus.stderr).toBe(0);
      const identity = await host.runPromise(
        Schema.decodeUnknownEffect(stackIdentitySchema)(preparedStatus.stdout),
      );
      serving = spawnSupabase(["functions", "serve", "--no-verify-jwt"], options);
      await serving.waitForOutput(/Serving functions on/, 120_000);
      const stack = await host.runPromise(
        openStack(identity.identity.id).pipe(
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ SUPABASE_HOME: home.dir })),
          ),
        ),
      );
      const functions = await host.runPromise(stack.services.get({ name: "functions" }));
      // The stream begins with the current snapshot, so it covers startup already in progress.
      functionsReady = host.runPromise(
        Stream.runHead(
          functions.followStatus.pipe(
            Stream.filter(
              (status) =>
                status.phase === "ready" || status.phase === "failed" || status.phase === "stopped",
            ),
          ),
        ).pipe(
          Effect.flatMap((snapshot) =>
            Option.match(snapshot, {
              onNone: () => Effect.fail(new Error("Functions status stream ended before ready")),
              onSome: (status) =>
                status.phase === "ready"
                  ? Effect.succeed(status)
                  : Effect.fail(new Error(`Functions startup ended in ${status.phase}`)),
            }),
          ),
          Effect.asVoid,
          Effect.timeout("120 seconds"),
        ),
      );
      await functionsReady;
      const result = await runSupabase(["stack", "status", "--output-format", "json"], options);
      expect(result.exitCode, result.stderr).toBe(0);
      const status = await host.runPromise(Schema.decodeUnknownEffect(statusSchema)(result.stdout));
      expect(status.instances.find(({ service }) => service === "database")?.phase).toBe("stopped");
      expect(status.instances.find(({ service }) => service === "functions")?.phase).toBe("ready");
      const request = HttpClient.get(new URL("/functions/v1/hello", status.endpoints.api.url)).pipe(
        Effect.flatMap((response) => response.text),
        Effect.timeout("15 seconds"),
      );
      expect(await host.runPromise(request)).toBe("still-serving");
      const externalRequest = HttpClient.get(
        new URL("/functions/v1/external", status.endpoints.api.url),
      ).pipe(
        Effect.flatMap((response) => response.text),
        Effect.timeout("15 seconds"),
      );
      const externalResponse = await host.runPromise(externalRequest);
      expect(externalResponse).toBe("external-helper:external-asset\n");
      serving.kill("SIGINT");
      const exited = await serving.waitForExit(30_000);
      expect(exited.exitCode, exited.stderr).toBe(0);
      serving = undefined;
      expect(await host.runPromise(request)).toBe("still-serving");
    } catch (error) {
      failures.push(error);
    }
    try {
      if (serving !== undefined) {
        serving.kill("SIGTERM");
        await serving.waitForExit(30_000);
      }
      if (functionsReady !== undefined) await Promise.allSettled([functionsReady]);
      const destroyed = await runSupabase(["stack", "destroy", "--yes"], {
        ...options,
        exitTimeoutMs: 120_000,
      });
      expect(destroyed.exitCode, destroyed.stderr).toBe(0);
      await project.cleanup();
      home[Symbol.dispose]();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw new AggregateError(failures, "Functions CLI lifecycle failed");
  },
);
