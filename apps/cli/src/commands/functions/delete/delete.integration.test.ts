import { describe, expect, it } from "@effect/vitest";
import { BunCrypto } from "@effect/platform-bun";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Schema, Stdio } from "effect";

import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { stripControlSequences } from "../../../shared/output/strip-control-sequences.ts";
import {
  VALID_REF,
  buildTestRuntime,
  jsonResponse,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { mockContextualAnalytics, mockOutput, mockTty } from "../../../../tests/helpers/mocks.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  projectResponse,
  realLinkedProjectCache,
} from "../../../../tests/helpers/permission-real-layers.ts";
import { functionsDeleteHandler } from "./delete.command.ts";
import { functionsDelete } from "./delete.handler.ts";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const tempRoot = useTempWorkdir("supabase-functions-delete-");

describe("functions delete", () => {
  it.effect("deletes a function natively through the Management API", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: null } });
    const linkedProjectCache = mockLinkedProjectCacheTracked();
    const telemetry = mockTelemetryStateTracked();
    const layer = buildTestRuntime({
      out,
      api,
      cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
      linkedProjectCache: linkedProjectCache.layer,
      telemetry: telemetry.layer,
    });

    return Effect.gen(function* () {
      yield* functionsDelete({
        functionName: "hello-world",
        projectRef: Option.none(),
      });

      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.method).toBe("DELETE");
      expect(api.requests[0]?.url).toBe(
        "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/functions/hello-world",
      );
      expect(stripControlSequences(out.stdoutText)).toBe(
        "Deleted Function hello-world from project abcdefghijklmnopqrst.\n",
      );
      expect(linkedProjectCache.cached).toBe(true);
      expect(telemetry.flushed).toBe(true);
      assertPermissionDrift({
        command: "functions delete",
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses an explicit project ref", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: null } });
    const layer = buildTestRuntime({
      out,
      api,
      cliSettings: mockCommandSettings({
        workdir: tempRoot.current,
        projectId: Option.none(),
      }),
    });

    return Effect.gen(function* () {
      yield* functionsDelete({
        functionName: "hello-world",
        projectRef: Option.some("qrstuvwxyzabcdefghij"),
      });

      expect(api.requests[0]?.url).toContain("/projects/qrstuvwxyzabcdefghij/functions/");
      assertPermissionDrift({
        command: "functions delete",
        activeFlags: { "project-ref": "qrstuvwxyzabcdefghij" },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("picks a project interactively and fills the linked-project cache", () => {
    const out = mockOutput({ promptSelectResponses: [VALID_REF] });
    const api = mockCommandPlatformApi({
      handler: (request) =>
        Effect.succeed(
          request.url === "https://api.supabase.com/v1/projects"
            ? jsonResponse(request, 200, [projectResponse(VALID_REF)])
            : request.url === `https://api.supabase.com/v1/projects/${VALID_REF}`
              ? jsonResponse(request, 200, projectResponse(VALID_REF))
              : jsonResponse(request, 200, null),
        ),
    });
    const cliSettings = mockCommandSettings({
      workdir: tempRoot.current,
      projectId: Option.none(),
    });
    const layer = buildTestRuntime({
      out,
      api,
      cliSettings,
      tty: mockTty({ stdinIsTty: true, stdoutIsTty: true }),
      linkedProjectCache: realLinkedProjectCache({ httpClient: api.httpClientLayer, cliSettings }),
    });

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cachePath = `${tempRoot.current}/supabase/.temp/linked-project.json`;
      expect(yield* fs.exists(cachePath)).toBe(false);
      yield* functionsDelete({ functionName: "hello-world", projectRef: Option.none() });
      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        "GET https://api.supabase.com/v1/projects",
        `DELETE https://api.supabase.com/v1/projects/${VALID_REF}/functions/hello-world`,
        `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
      ]);
      expect(stripControlSequences(out.stdoutText)).toBe(
        `Deleted Function hello-world from project ${VALID_REF}.\n`,
      );
      expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
        ref: VALID_REF,
      });
      assertPermissionDrift({
        command: "functions delete",
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect.each(["1leading-digit", "has space", "dot.name"])(
    "rejects the invalid slug %j before any Management API request",
    (functionName) => {
      const api = mockCommandPlatformApi({ response: { status: 200, body: null } });
      const linkedProjectCache = mockLinkedProjectCacheTracked();
      const layer = buildTestRuntime({
        out: mockOutput({ format: "text" }),
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
        linkedProjectCache: linkedProjectCache.layer,
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          functionsDelete({ functionName, projectRef: Option.none() }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("InvalidFunctionSlugError");
        }
        expect(api.requests).toEqual([]);
        expect(linkedProjectCache.cached).toBe(false);
        assertPermissionDrift({
          command: "functions delete",
          requests: api.requests,
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "does not redact --project-ref in cli_command_executed (Go parity: cmd/functions.go:153)",
    () => {
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi({ response: { status: 200, body: null } });
      const analytics = mockContextualAnalytics();
      const layer = Layer.mergeAll(
        buildTestRuntime({
          out,
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
          analytics,
        }),
        commandRuntimeLayer(["functions", "delete"]).pipe(Layer.provide(BunCrypto.layer)),
        Stdio.layerTest({
          args: Effect.succeed([
            "functions",
            "delete",
            "hello-world",
            "--project-ref",
            "abcdefghijklmnopqrst",
          ]),
        }),
      );

      return Effect.gen(function* () {
        yield* functionsDeleteHandler({
          functionName: "hello-world",
          projectRef: Option.some("abcdefghijklmnopqrst"),
        });

        const event = analytics.captured.find((c) => c.event === "cli_command_executed");
        expect(event?.properties.flags).toEqual({ "project-ref": "abcdefghijklmnopqrst" });
      }).pipe(Effect.provide(layer));
    },
  );
});
