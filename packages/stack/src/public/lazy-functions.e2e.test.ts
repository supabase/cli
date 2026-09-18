import { NodeServices } from "@effect/platform-node";
import { Config, Effect, FileSystem, Layer, ManagedRuntime, Option, Path } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { afterAll, expect, test } from "vitest";
import { isolatedInstanceApi } from "../../tests/helpers/instance-api.ts";

const host = ManagedRuntime.make(Layer.merge(NodeServices.layer, FetchHttpClient.layer));
afterAll(() => host.dispose());
const selectedRuntime = Option.getOrUndefined(
  Effect.runSync(Config.option(Config.string("SUPABASE_STACK_E2E_RUNTIME"))),
);

for (const runtime of [{ kind: "native" }, { kind: "container", engine: "docker" }] as const) {
  test.skipIf(selectedRuntime !== undefined && selectedRuntime !== runtime.kind)(
    `demand wakes Functions after a lazy whole start in ${runtime.kind}`,
    { timeout: 180_000 },
    // oxlint-disable-next-line effecttsgo/async-function -- Exercises the public Promise API through a real supervisor and HTTP ingress.
    async () => {
      const root = await host.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectory({ prefix: "supabase-lazy-functions-" });
          const directory = path.join(root, "supabase", "functions", "hello");
          yield* fs.makeDirectory(directory, { recursive: true });
          yield* fs.writeFileString(
            path.join(directory, "index.ts"),
            'Deno.serve(() => new Response("awake"));\n',
          );
          return root;
        }),
      );
      const { createStack } = await host.runPromise(isolatedInstanceApi(root));
      const stack = await createStack({
        projectRoot: root,
        runtime,
        initialConfig: {
          capabilities: {
            database: { enabled: false },
            auth: { enabled: false },
            rest: { enabled: false },
            realtime: { enabled: false },
            storage: { enabled: false },
            studio: { enabled: false },
            mail: { enabled: false },
            analytics: { enabled: false },
            pooler: { enabled: false },
            functions: {
              enabled: true,
              activation: "lazy",
              settings: {
                functions_root: "supabase/functions",
                functions: { hello: { enabled: true, verify_jwt: false } },
              },
            },
          },
        },
      });
      const failures: unknown[] = [];
      try {
        const started = await stack.start();
        const functions = await stack.services.get({ name: "functions" });
        expect((await functions.status()).phase).toBe("dormant");
        const api = started.endpoints.api;
        if (api === undefined) throw new Error("Lazy start did not expose managed API ingress");
        const body = await host.runPromise(
          HttpClient.get(new URL("/functions/v1/hello", api.url)).pipe(
            Effect.flatMap((response) => response.text),
            Effect.timeout("30 seconds"),
          ),
        );
        expect(body).toBe("awake");
        expect((await functions.status()).phase).toBe("ready");
      } catch (error) {
        failures.push(error);
      }
      try {
        await stack.destroy();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0)
        throw new AggregateError(failures, `Lazy start failed; retained ${root}`);
      await host.runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(root, { recursive: true })),
      );
    },
  );
}
