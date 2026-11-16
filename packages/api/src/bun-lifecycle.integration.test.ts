import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import { createApiClient } from "./bun.ts";

describe("Bun client lifecycle", () => {
  test("serves requests through the Bun entrypoint and rejects operations after disposal", () => {
    const paths: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        paths.push(new URL(request.url).pathname);
        return Response.json([]);
      },
    });
    return Effect.runPromise(
      Effect.acquireUseRelease(
        Effect.promise(() =>
          createApiClient({
            baseUrl: server.url.toString(),
            accessToken: "test-token",
          }),
        ),
        (client) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => expect(client.v1.listAllProjects()).resolves.toEqual([]));
            expect(paths).toEqual(["/v1/projects"]);
            yield* Effect.promise(() => client.dispose());
            yield* Effect.promise(() => expect(client.v1.listAllProjects()).rejects.toThrow());
            expect(paths).toEqual(["/v1/projects"]);
          }),
        (client) =>
          Effect.promise(() => client.dispose()).pipe(
            Effect.andThen(Effect.promise(() => server.stop(true))),
          ),
      ),
    );
  });
});
