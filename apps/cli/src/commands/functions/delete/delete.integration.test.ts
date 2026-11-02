import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Schema } from "effect";

import { YesFlag } from "../../../command-internal/global-flags.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
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
import { describeHostedConsent } from "../../../../tests/helpers/hosted-consent.ts";
import { describeHostedTargetSelection } from "../../../../tests/helpers/hosted-target-selection.ts";
import { mockOutput, mockTty } from "../../../../tests/helpers/mocks.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  projectResponse,
  realLinkedProjectCache,
} from "../../../../tests/helpers/permission-real-layers.ts";
import { functionsDelete } from "./delete.handler.ts";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const tempRoot = useTempWorkdir("supabase-functions-delete-");

const approvedHostedMutation = Layer.mergeAll(
  Layer.succeed(YesFlag, true),
  Layer.succeed(TargetPolicy, { group: "hosted", consent: "no" }),
);

describe("functions delete", () => {
  it.effect("deletes a function natively through the Management API", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: null } });
    const linkedProjectCache = mockLinkedProjectCacheTracked();
    const telemetry = mockTelemetryStateTracked();
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
        linkedProjectCache: linkedProjectCache.layer,
        telemetry: telemetry.layer,
      }),
      approvedHostedMutation,
    );

    return Effect.gen(function* () {
      yield* functionsDelete({
        functionName: "hello-world",
        remote: Option.none(),
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

  it.effect("uses an explicit --remote=<ref>", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: null } });
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({
          workdir: tempRoot.current,
          projectId: Option.none(),
        }),
      }),
      approvedHostedMutation,
    );

    return Effect.gen(function* () {
      yield* functionsDelete({
        functionName: "hello-world",
        remote: Option.some({ _tag: "Ref", ref: "qrstuvwxyzabcdefghij" }),
        projectRef: Option.none(),
      });

      expect(api.requests[0]?.url).toContain("/projects/qrstuvwxyzabcdefghij/functions/");
      assertPermissionDrift({
        command: "functions delete",
        activeFlags: { remote: "qrstuvwxyzabcdefghij" },
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
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out,
        api,
        cliSettings,
        tty: mockTty({ stdinIsTty: true, stdoutIsTty: true }),
        linkedProjectCache: realLinkedProjectCache({
          httpClient: api.httpClientLayer,
          cliSettings,
        }),
      }),
      approvedHostedMutation,
    );

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cachePath = `${tempRoot.current}/supabase/.temp/linked-project.json`;
      expect(yield* fs.exists(cachePath)).toBe(false);
      yield* functionsDelete({
        functionName: "hello-world",
        remote: Option.none(),
        projectRef: Option.none(),
      });
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
      const layer = Layer.mergeAll(
        buildTestRuntime({
          out: mockOutput({ format: "text" }),
          api,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
          linkedProjectCache: linkedProjectCache.layer,
        }),
        approvedHostedMutation,
      );

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          functionsDelete({ functionName, remote: Option.none(), projectRef: Option.none() }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("InvalidFunctionSlugError");
        }
        expect(api.requests).toEqual([]);
        expect(linkedProjectCache.cached).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );
});

describeHostedConsent("functions delete", {
  api: { response: { status: 200, body: null } },
  invoke: () => ({
    run: functionsDelete({
      functionName: "hello-world",
      remote: Option.none(),
      projectRef: Option.none(),
    }),
  }),
});

describeHostedTargetSelection("functions delete", {
  operands: ["hello-world"],
  respond: (request) => Effect.succeed(jsonResponse(request, 200, null)),
  run: (flags) => functionsDelete({ functionName: "hello-world", ...flags }),
});
