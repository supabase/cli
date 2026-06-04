import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { CliConfig } from "../../config/cli-config.service.ts";
import {
  ProjectLinkState,
  type ProjectLinkStateValue,
} from "../../config/project-link-state.service.ts";
import { InvalidProjectLinkStateError } from "../../config/project-link-state.service.ts";
import { Credentials } from "../../auth/credentials.service.ts";
import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { CommandRuntime } from "../../../shared/runtime/command-runtime.service.ts";
import { services } from "./services.handler.ts";

const LINKED_REF = "abcdefghijklmnopqrst";

function linkedStateFixture(): ProjectLinkStateValue {
  return {
    project: {
      ref: LINKED_REF,
      name: "Linked Project",
      organization_id: "org-id",
      organization_slug: "org",
    },
    active_branch: { ref: "branch-ref", name: "main", is_default: true },
    fetchedAt: "2026-03-13T12:00:00.000Z",
    versions: {},
  };
}

function setup(
  opts: {
    format?: "text" | "json" | "stream-json";
    linkedState?: Option.Option<ProjectLinkStateValue>;
    invalidLinkedState?: boolean;
    accessToken?: string;
    apiUrl?: string;
  } = {},
) {
  const out = mockOutput({
    format: opts.format ?? "text",
    interactive: (opts.format ?? "text") === "text",
  });
  const linkedState = opts.linkedState ?? Option.none<ProjectLinkStateValue>();

  return {
    out,
    layer: Layer.mergeAll(
      out.layer,
      FetchHttpClient.layer,
      Layer.succeed(
        CliConfig,
        CliConfig.of({
          apiUrl: opts.apiUrl ?? "https://api.supabase.com",
          dashboardUrl: "https://supabase.com/dashboard",
          projectHost: "supabase.co",
          telemetryPosthogHost: "https://ph.supabase.com",
          telemetryPosthogKey: Option.none(),
          accessToken: Option.none(),
          noKeyring: Option.none(),
          supabaseHome: "/tmp/supabase-home",
          debug: Option.none(),
          telemetryDebug: Option.none(),
          telemetryDisabled: Option.none(),
          doNotTrack: Option.none(),
        }),
      ),
      Layer.succeed(
        Credentials,
        Credentials.of({
          getAccessToken: Effect.succeed(
            opts.accessToken === undefined
              ? Option.none()
              : Option.some(Redacted.make(opts.accessToken)),
          ),
          saveAccessToken: () => Effect.die("unexpected saveAccessToken"),
          deleteAccessToken: Effect.die("unexpected deleteAccessToken"),
        }),
      ),
      Layer.succeed(
        ProjectLinkState,
        ProjectLinkState.of({
          load: opts.invalidLinkedState
            ? Effect.fail(
                new InvalidProjectLinkStateError({
                  detail: "broken project link state",
                  suggestion: "fix it",
                }),
              )
            : Effect.succeed(linkedState),
          save: () => Effect.die("unexpected save"),
          clear: Effect.die("unexpected clear"),
          getActiveBranch: Effect.succeed(Option.none()),
          setActiveBranch: () => Effect.die("unexpected setActiveBranch"),
        }),
      ),
      Layer.succeed(
        CommandRuntime,
        CommandRuntime.of({
          commandPath: ["services"],
          commandRunId: "run-services-test",
        }),
      ),
    ),
  };
}

describe("next services", () => {
  it.live("prints the services table in text mode", () => {
    const { layer, out } = setup();

    return Effect.gen(function* () {
      yield* services().pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("supabase/postgres");
      expect(out.stdoutText).toContain("supabase/gotrue");
      expect(out.stdoutText).toContain("supabase/storage-api");
      expect(out.stderrText).toBe("");
    });
  });

  it.live("emits structured services data in json mode", () => {
    const { layer, out } = setup({ format: "json" });

    return Effect.gen(function* () {
      yield* services().pipe(Effect.provide(layer));

      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toMatchObject({
        services: expect.arrayContaining([
          expect.objectContaining({ name: "supabase/postgres", local: "17.6.1.132" }),
        ]),
      });
    });
  });

  it.live("falls back to local output when linked state is invalid", () => {
    const { layer, out } = setup({ invalidLinkedState: true });

    return Effect.gen(function* () {
      yield* services().pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("supabase/postgres");
      expect(out.stderrText).toBe("");
    });
  });

  it.live("merges linked service versions and warns on a version mismatch", () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === `/v1/projects/${LINKED_REF}/api-keys`) {
          return Response.json([
            {
              name: "anon",
              id: "publishable-id",
              type: "publishable",
              api_key: "publishable-key",
              description: null,
            },
          ]);
        }

        if (url.pathname === `/v1/projects/${LINKED_REF}`) {
          return Response.json({
            id: LINKED_REF,
            ref: LINKED_REF,
            organization_id: "org-id",
            organization_slug: "org",
            name: "Linked Project",
            region: "us-east-1",
            created_at: "2026-03-13T12:00:00.000Z",
            status: "ACTIVE_HEALTHY",
            database: {
              host: "db.supabase.internal",
              version: "17.6.1.200",
              postgres_engine: "17",
              release_channel: "ga",
            },
          });
        }

        return new Response("not found", { status: 404 });
      },
    });

    const { layer, out } = setup({
      format: "json",
      linkedState: Option.some(linkedStateFixture()),
      accessToken: "sbp_token",
      apiUrl: server.url.origin,
    });

    return Effect.gen(function* () {
      yield* services().pipe(Effect.provide(layer));

      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toMatchObject({
        services: expect.arrayContaining([
          expect.objectContaining({
            name: "supabase/postgres",
            local: "17.6.1.132",
            remote: "17.6.1.200",
          }),
        ]),
      });
      expect(out.stderrText).toContain("WARNING:");
    }).pipe(Effect.ensuring(Effect.promise(() => server.stop(true))));
  });
});
