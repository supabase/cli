import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import * as HttpClient from "effect/http/HttpClient";
import { startReplayServer } from "../../cli-e2e/src/server/replay-server.ts";
import { readRequestLogCount, resetReplay } from "./replay-control.ts";

const fixturesDir = new URL("../../cli-e2e/fixtures", import.meta.url).pathname;
const SCENARIO = "projects-list-renders-project-list";

const replayServer = startReplayServer({ fixturesDir, record: false, stagingUrl: undefined });

const callApi = (url: string, path: string) =>
  HttpClient.HttpClient.use((client) => client.get(new URL(path, url).toString()));

describe("replay control against the replay server", () => {
  it.effect("serves a consumed scenario again and starts each launch with an empty log", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* replayServer;

        yield* resetReplay(server.url, SCENARIO);
        const first = yield* callApi(server.url, "/v1/projects");
        const logged = yield* readRequestLogCount(server.url);

        yield* resetReplay(server.url, SCENARIO);
        const cleared = yield* readRequestLogCount(server.url);
        const second = yield* callApi(server.url, "/v1/projects");

        expect([first.status, second.status]).toEqual([200, 200]);
        expect(logged).toBe(1);
        expect(cleared).toBe(0);
      }),
    ).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("fails when the scenario does not exist instead of keeping the previous one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* replayServer;

        const failure = yield* resetReplay(server.url, "no-such-scenario").pipe(Effect.flip);

        expect(failure._tag).toBe("ReplayControlError");
        expect(failure.step).toBe("POST /_ctrl/scenario");
      }),
    ).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("fails when the server is unreachable", () =>
    Effect.gen(function* () {
      const failure = yield* resetReplay("http://127.0.0.1:1", undefined).pipe(Effect.flip);

      expect(failure._tag).toBe("ReplayControlError");
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
});
