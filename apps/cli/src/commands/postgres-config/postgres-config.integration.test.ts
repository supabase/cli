import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, FileSystem, Schema } from "effect";
import { describeHostedConsent } from "../../../tests/helpers/hosted-consent.ts";
import { mockOutput, mockTty } from "../../../tests/helpers/mocks.ts";
import { makeApiClient } from "@supabase/api/effect";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { CommandPlatformApi } from "../../auth/command-platform-api.service.ts";
import {
  DEFAULT_API_URL,
  VALID_TOKEN,
  VALID_REF,
  buildTestRuntime,
  jsonResponse,
  transportFailure,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
  unverifiedTargetBanner,
} from "../../../tests/helpers/command-mocks.ts";
import { YesFlag } from "../../command-internal/global-flags.ts";
import { TargetPolicy } from "../../command-internal/target/target-policy.ts";
import {
  assertBlockDrift,
  assertPermissionDrift,
} from "../../../tests/helpers/permission-drift.ts";
import {
  projectResponse,
  realLinkedProjectCache,
} from "../../../tests/helpers/permission-real-layers.ts";
import { postgresConfigDelete } from "./delete/delete.handler.ts";
import { postgresConfigGet } from "./get/get.handler.ts";
import { postgresConfigRead, postgresConfigWrite } from "./postgres-config.shared.ts";
import { postgresConfigUpdate } from "./update/update.handler.ts";

type OutputFlagValue = "env" | "pretty" | "json" | "toml" | "yaml";

const failure = (
  exit: Exit.Exit<unknown, unknown>,
): { readonly _tag: string; readonly message: string } | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
  return error instanceof Error
    ? { _tag: String(Reflect.get(error, "_tag")), message: error.message }
    : undefined;
};

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const tempRoot = useTempWorkdir("supabase-postgres-config-int-");

const confirmedBy = (action: string) =>
  `Confirmed by --yes: ${action} on project ${VALID_REF}\n`;
const UPDATE_CONFIRMED = confirmedBy("Update the Postgres config overrides");
const DELETE_CONFIRMED = confirmedBy("Delete Postgres config overrides");

const PROJECTS_URL = "https://api.supabase.com/v1/projects";
const PROJECT_URL = `${PROJECTS_URL}/${VALID_REF}`;
const CONFIG_URL = `${PROJECT_URL}/config/database/postgres`;

const requestLines = (api: ReturnType<typeof mockCommandPlatformApi>) =>
  api.requests.map(({ method, url }) => `${method} ${url}`);

// No linked ref anywhere, so the picker runs and the real cache fills after the command.
function composedRuntime(opts: {
  readonly stored: Record<string, unknown>;
  readonly updated: Record<string, unknown>;
}) {
  const out = mockOutput({ promptSelectResponses: [VALID_REF] });
  const api = mockCommandPlatformApi({
    handler: (request) =>
      Effect.succeed(
        request.url === PROJECTS_URL
          ? jsonResponse(request, 200, [projectResponse(VALID_REF)])
          : request.url === PROJECT_URL
            ? jsonResponse(request, 200, projectResponse(VALID_REF))
            : request.url === CONFIG_URL
              ? jsonResponse(request, 200, request.method === "PUT" ? opts.updated : opts.stored)
              : jsonResponse(request, 404, { message: "unrouted request" }),
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
      tty: mockTty({ stdinIsTty: true }),
      linkedProjectCache: realLinkedProjectCache({ httpClient: api.httpClientLayer, cliSettings }),
    }),
    Layer.succeed(YesFlag, true),
    Layer.succeed(TargetPolicy, { group: "hosted", consent: "no" }),
  );
  return { out, api, layer };
}

const readLinkedProjectCache = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* decodeJson(
    yield* fs.readFileString(`${tempRoot.current}/supabase/.temp/linked-project.json`),
  );
});

// The shared mock disables client retries; this restores the production default so a test can
// prove a command opts a request out of retrying.
const withProductionRetries = (
  api: ReturnType<typeof mockCommandPlatformApi>,
): ReturnType<typeof mockCommandPlatformApi> => ({
  ...api,
  layer: Layer.effect(
    CommandPlatformApi,
    makeApiClient({ baseUrl: DEFAULT_API_URL, accessToken: VALID_TOKEN }),
  ).pipe(Layer.provide(api.httpClientLayer)),
});

const textResponse = (request: Parameters<typeof jsonResponse>[0], status: number, body: string) =>
  HttpClientResponse.fromWeb(request, new Response(body, { status }));

function runtimeWith(opts: {
  readonly out: ReturnType<typeof mockOutput>;
  readonly api: ReturnType<typeof mockCommandPlatformApi>;
  readonly telemetry?: ReturnType<typeof mockTelemetryStateTracked>["layer"];
  readonly linkedProjectCache?: ReturnType<typeof mockLinkedProjectCacheTracked>["layer"];
  readonly outputFlag?: OutputFlagValue;
}) {
  return Layer.mergeAll(
    buildTestRuntime({
      out: opts.out,
      api: opts.api,
      cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
      telemetry: opts.telemetry,
      linkedProjectCache: opts.linkedProjectCache,
      outputFlag: opts.outputFlag === undefined ? Option.none() : Option.some(opts.outputFlag),
    }),
    Layer.succeed(YesFlag, true),
    Layer.succeed(TargetPolicy, { group: "hosted", consent: "no" }),
  );
}

describe("postgres-config get", () => {
  it.effect("prints the Glamour table with stderr headings in text mode", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({
      response: { status: 200, body: { max_connections: 100 } },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* postgresConfigGet({ projectRef: Option.none() });
      expect(out.progressEvents[0]?.message).toBe("Fetching Postgres config...");
      expect(out.stderrText).toBe(
        unverifiedTargetBanner() +
          "- Custom Postgres Config -\n- End of Custom Postgres Config -\n",
      );
      expect(out.stdoutText).toContain("Parameter");
      expect(out.stdoutText).toContain("max_connections");
      expect(out.stdoutText).toContain("100");
      expect(api.requests[0]?.method).toBe("GET");
      expect(api.requests[0]?.url).toContain(`/v1/projects/${VALID_REF}/config/database/postgres`);
      assertPermissionDrift({
        command: "postgres-config get",
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("picks a project, reads its config and fills the linked-project cache", () => {
    const { out, api, layer } = composedRuntime({
      stored: { max_connections: 100 },
      updated: {},
    });

    return Effect.gen(function* () {
      yield* postgresConfigGet({ projectRef: Option.none() });
      expect(requestLines(api)).toEqual([
        `GET ${PROJECTS_URL}`,
        `GET ${CONFIG_URL}`,
        `GET ${PROJECT_URL}`,
      ]);
      expect(out.stdoutText).toContain("max_connections");
      expect(yield* readLinkedProjectCache).toMatchObject({ ref: VALID_REF });
      assertPermissionDrift({
        command: "postgres-config get",
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "renders a large integral config value in exponent notation in the pretty table",
    () => {
      // The table renders every JSON number as a float64 in shortest round-trip form, so 1000000
      // renders as `1e+06`, never `1000000`.
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi({
        response: { status: 200, body: { max_connections: 1000000 } },
      });
      const layer = runtimeWith({ out, api });

      return Effect.gen(function* () {
        yield* postgresConfigGet({ projectRef: Option.none() });
        expect(out.stdoutText).toContain("1e+06");
        expect(out.stdoutText).not.toContain("1000000");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("emits TOML bytes for --output toml", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({
      response: { status: 200, body: { max_connections: 100 } },
    });
    const layer = runtimeWith({ out, api, outputFlag: "toml" });

    return Effect.gen(function* () {
      yield* postgresConfigGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe("max_connections = 100.0\n");
      expect(out.stderrText).toBe(unverifiedTargetBanner());
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps multi-key pretty and TOML output deterministic", () => {
    const responseBody = {
      wal_keep_size: "1GB",
      max_connections: 100,
      shared_buffers: "128MB",
    };

    return Effect.gen(function* () {
      const prettyOut = mockOutput({ format: "text" });
      const prettyApi = mockCommandPlatformApi({
        response: { status: 200, body: responseBody },
      });
      yield* postgresConfigGet({ projectRef: Option.none() }).pipe(
        Effect.provide(runtimeWith({ out: prettyOut, api: prettyApi })),
      );

      expect(prettyOut.stdoutText.indexOf("max_connections")).toBeLessThan(
        prettyOut.stdoutText.indexOf("shared_buffers"),
      );
      expect(prettyOut.stdoutText.indexOf("shared_buffers")).toBeLessThan(
        prettyOut.stdoutText.indexOf("wal_keep_size"),
      );

      const tomlOut = mockOutput({ format: "text" });
      const tomlApi = mockCommandPlatformApi({
        response: { status: 200, body: responseBody },
      });
      yield* postgresConfigGet({ projectRef: Option.none() }).pipe(
        Effect.provide(runtimeWith({ out: tomlOut, api: tomlApi, outputFlag: "toml" })),
      );

      expect(tomlOut.stdoutText).toBe(
        'max_connections = 100.0\nshared_buffers = "128MB"\nwal_keep_size = "1GB"\n',
      );
    });
  });

  it.effect("emits env output for --output env", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({
      response: { status: 200, body: { track_commit_timestamp: true } },
    });
    const layer = runtimeWith({ out, api, outputFlag: "env" });

    return Effect.gen(function* () {
      yield* postgresConfigGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe('TRACK_COMMIT_TIMESTAMP="true"\n');
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits JSON and YAML bytes", () =>
    Effect.gen(function* () {
      for (const [outputFlag, expected] of [
        ["json", '"max_connections": 100'],
        ["yaml", "max_connections: 100"],
      ] as const) {
        const out = mockOutput({ format: "text" });
        const api = mockCommandPlatformApi({
          response: { status: 200, body: { max_connections: 100 } },
        });
        const layer = runtimeWith({ out, api, outputFlag });
        yield* postgresConfigGet({ projectRef: Option.none() }).pipe(Effect.provide(layer));
        expect(out.stdoutText).toContain(expected);
        expect(out.stderrText).toBe(unverifiedTargetBanner());
      }
    }),
  );

  it.effect("emits a JSON success payload for --output-format json", () => {
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({
      response: { status: 200, body: { max_connections: 100 } },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* postgresConfigGet({ projectRef: Option.none() });
      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toEqual({ max_connections: 100 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets the --output flag win over --output-format json", () => {
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({
      response: { status: 200, body: { max_connections: 100 } },
    });
    const layer = runtimeWith({ out, api, outputFlag: "toml" });

    return Effect.gen(function* () {
      yield* postgresConfigGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe("max_connections = 100.0\n");
      expect(out.messages.some((message) => message.type === "success")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("treats --output pretty as the human-readable table", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({
      response: { status: 200, body: { max_connections: 100 } },
    });
    const layer = runtimeWith({ out, api, outputFlag: "pretty" });

    return Effect.gen(function* () {
      yield* postgresConfigGet({ projectRef: Option.none() });
      expect(out.stderrText).toBe(
        unverifiedTargetBanner() +
          "- Custom Postgres Config -\n- End of Custom Postgres Config -\n",
      );
      expect(out.stdoutText).toContain("Parameter");
      expect(out.stdoutText).toContain("max_connections");
    }).pipe(Effect.provide(layer));
  });

  it.effect("shows stored overrides the typed update contract does not model", () => {
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({
      response: { status: 200, body: { max_connections: 100, stored_only_key: "x" } },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* postgresConfigGet({ projectRef: Option.none() });
      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toEqual({ max_connections: 100, stored_only_key: "x" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps HTTP 503 to the get unexpected-status error", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 503, body: {} } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(postgresConfigGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("PostgresConfigGetUnexpectedStatusError");
        expect(causeText).toContain("unexpected config overrides status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps transport failures to the get network error", () => {
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({ network: "fail" });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(postgresConfigGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("PostgresConfigGetNetworkError");
        expect(causeText).toContain("failed to retrieve Postgres config overrides");
      }
    }).pipe(Effect.provide(layer));
  });
});

describe("postgres-config update", () => {
  it.effect("merges current overrides and coerces --config values into the PUT body", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({
      byMethod: {
        GET: { status: 200, body: { wal_keep_size: "1GB" } },
        PUT: {
          status: 200,
          body: {
            wal_keep_size: "1GB",
            max_connections: 100,
            track_commit_timestamp: true,
            statement_timeout: "600",
            shared_buffers: "128MB",
            restart_database: false,
          },
        },
      },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* postgresConfigUpdate({
        projectRef: Option.none(),
        config: [
          "max_connections=100",
          "track_commit_timestamp=true",
          "statement_timeout=600",
          "shared_buffers=128MB",
        ],
        replaceExistingOverrides: false,
        noRestart: true,
      });
      expect(out.progressEvents[0]?.message).toBe("Updating Postgres config...");
      expect(api.requests).toHaveLength(2);
      expect(api.requests[1]?.method).toBe("PUT");
      expect(api.requests[1]?.body).toEqual({
        wal_keep_size: "1GB",
        max_connections: 100,
        track_commit_timestamp: true,
        statement_timeout: "600",
        shared_buffers: "128MB",
        restart_database: false,
      });
      expect(out.stderrText).toBe(
        unverifiedTargetBanner() +
          UPDATE_CONFIRMED +
          "- Custom Postgres Config -\n- End of Custom Postgres Config -\n",
      );
      assertPermissionDrift({
        command: "postgres-config update",
        activeFlags: { "replace-existing-overrides": false, "no-restart": true, config: true },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("picks a project, merges overrides and fills the linked-project cache", () => {
    const { out, api, layer } = composedRuntime({
      stored: { wal_keep_size: "1GB" },
      updated: { wal_keep_size: "1GB", max_connections: 100 },
    });

    return Effect.gen(function* () {
      yield* postgresConfigUpdate({
        projectRef: Option.none(),
        config: ["max_connections=100"],
        replaceExistingOverrides: false,
        noRestart: false,
      });
      expect(requestLines(api)).toEqual([
        `GET ${PROJECTS_URL}`,
        `GET ${CONFIG_URL}`,
        `PUT ${CONFIG_URL}`,
        `GET ${PROJECT_URL}`,
      ]);
      expect(api.requests[2]?.body).toEqual({ wal_keep_size: "1GB", max_connections: 100 });
      expect(out.stdoutText).toContain("max_connections");
      expect(yield* readLinkedProjectCache).toMatchObject({ ref: VALID_REF });
      assertPermissionDrift({
        command: "postgres-config update",
        activeFlags: { "replace-existing-overrides": false },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips the initial GET in replace mode", () => {
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({
      byMethod: {
        PUT: { status: 200, body: { max_connections: 100 } },
      },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* postgresConfigUpdate({
        projectRef: Option.none(),
        config: ["max_connections=100"],
        replaceExistingOverrides: true,
        noRestart: false,
      });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.method).toBe("PUT");
      expect(api.requests[0]?.body).toEqual({ max_connections: 100 });
      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toEqual({ max_connections: 100 });
      assertPermissionDrift({
        command: "postgres-config update",
        activeFlags: { "replace-existing-overrides": true },
        requests: api.requests,
      });
      expect(() =>
        assertPermissionDrift({
          command: "postgres-config update",
          activeFlags: { "replace-existing-overrides": true },
          requests: [{ method: "GET", url: CONFIG_URL }],
        }),
      ).toThrow(/condition doesn't hold/);
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits legacy output modes in replace mode", () =>
    Effect.gen(function* () {
      const cases = [
        {
          outputFlag: "json" as const,
          expected: '"max_connections": 100',
        },
        {
          outputFlag: "yaml" as const,
          expected: "max_connections: 100",
        },
        {
          outputFlag: "toml" as const,
          expected: "max_connections = 100.0\n",
        },
        {
          outputFlag: "env" as const,
          expected: "MAX_CONNECTIONS=100",
        },
      ];

      for (const testCase of cases) {
        const out = mockOutput({ format: "text" });
        const api = mockCommandPlatformApi({
          byMethod: {
            PUT: { status: 200, body: { max_connections: 100 } },
          },
        });
        const layer = runtimeWith({ out, api, outputFlag: testCase.outputFlag });
        yield* postgresConfigUpdate({
          projectRef: Option.none(),
          config: ["max_connections=100"],
          replaceExistingOverrides: true,
          noRestart: false,
        }).pipe(Effect.provide(layer));
        expect(out.stdoutText).toContain(testCase.expected);
        expect(out.stderrText).toBe(unverifiedTargetBanner() + UPDATE_CONFIRMED);
      }
    }),
  );

  it.effect("rejects an unknown --config parameter before sending the PUT", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({
      byMethod: { GET: { status: 200, body: { wal_keep_size: "1GB" } } },
    });
    const cache = mockLinkedProjectCacheTracked();
    const layer = runtimeWith({ out, api, linkedProjectCache: cache.layer });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        postgresConfigUpdate({
          projectRef: Option.none(),
          config: ["max_conections=100", "bogus=1", "max_connections=100"],
          replaceExistingOverrides: false,
          noRestart: false,
        }),
      );
      const error = failure(exit);
      expect(error?._tag).toBe("PostgresConfigUpdateSerializeError");
      expect(error?.message).toBe(
        "unknown Postgres config parameters: max_conections, bogus " +
          "(if this is a newly supported parameter, upgrade the CLI)",
      );
      expect(api.requests.map((request) => request.method)).toEqual(["GET"]);
      expect(cache.cached).toBe(true);
      assertPermissionDrift({
        command: "postgres-config update",
        activeFlags: { "replace-existing-overrides": false },
        requests: api.requests,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "forwards a stored override the typed contract does not model when updating another key",
    () => {
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi({
        byMethod: {
          GET: { status: 200, body: { wal_keep_size: "1GB", stored_only_key: "x" } },
          PUT: {
            status: 200,
            body: { wal_keep_size: "1GB", stored_only_key: "x", max_connections: 100 },
          },
        },
      });
      const layer = runtimeWith({ out, api });

      return Effect.gen(function* () {
        yield* postgresConfigUpdate({
          projectRef: Option.none(),
          config: ["max_connections=100"],
          replaceExistingOverrides: false,
          noRestart: false,
        });
        expect(api.requests.map((request) => request.method)).toEqual(["GET", "PUT"]);
        expect(api.requests[1]?.body).toEqual({
          wal_keep_size: "1GB",
          stored_only_key: "x",
          max_connections: 100,
        });
        expect(out.stdoutText).toContain("stored_only_key");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("lets a --config value replace the stored value of the same key", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({
      byMethod: {
        GET: { status: 200, body: { max_connections: 50, stored_only_key: "x" } },
        PUT: { status: 200, body: { max_connections: 100, stored_only_key: "x" } },
      },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* postgresConfigUpdate({
        projectRef: Option.none(),
        config: ["max_connections=100"],
        replaceExistingOverrides: false,
        noRestart: false,
      });
      expect(api.requests[1]?.body).toEqual({ max_connections: 100, stored_only_key: "x" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a value the typed contract rejects with its parameter name", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi();
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        postgresConfigUpdate({
          projectRef: Option.none(),
          config: ["max_connections=lots"],
          replaceExistingOverrides: true,
          noRestart: false,
        }),
      );
      expect(failure(exit)?.message).toMatch(
        /^invalid Postgres config value for max_connections: /,
      );
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects a numeric value for a string parameter locally with a unit hint", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi();
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        postgresConfigUpdate({
          projectRef: Option.none(),
          config: ["work_mem=4096"],
          replaceExistingOverrides: true,
          noRestart: false,
        }),
      );
      const error = failure(exit);
      expect(error?._tag).toBe("PostgresConfigUpdateSerializeError");
      expect(error?.message).toMatch(/^invalid Postgres config value for work_mem: /);
      expect(error?.message).toContain("(pass the value with its unit, such as 4096kB or 4096ms)");
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("sends a value with its unit as a string", () => {
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({
      byMethod: { PUT: { status: 200, body: { work_mem: "4096kB" } } },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* postgresConfigUpdate({
        projectRef: Option.none(),
        config: ["work_mem=4096kB"],
        replaceExistingOverrides: true,
        noRestart: false,
      });
      expect(api.requests.map((request) => request.body)).toEqual([{ work_mem: "4096kB" }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("shows response keys the typed contract does not model", () => {
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({
      byMethod: {
        PUT: { status: 200, body: { max_connections: 100, server_only_key: "x" } },
      },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* postgresConfigUpdate({
        projectRef: Option.none(),
        config: ["max_connections=100"],
        replaceExistingOverrides: true,
        noRestart: false,
      });
      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toEqual({ max_connections: 100, server_only_key: "x" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps a non-JSON 2xx PUT body to the update unmarshal error", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({
      handler: (request) => Effect.sync(() => textResponse(request, 200, "<html>")),
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        postgresConfigUpdate({
          projectRef: Option.none(),
          config: ["max_connections=100"],
          replaceExistingOverrides: true,
          noRestart: false,
        }),
      );
      const error = failure(exit);
      expect(error?._tag).toBe("PostgresConfigUpdateUnmarshalError");
      expect(error?.message).toMatch(/^failed to parse update response: /);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails before ref resolution on malformed config input", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi();
    const telemetry = mockTelemetryStateTracked();
    const cache = mockLinkedProjectCacheTracked();
    const layer = runtimeWith({
      out,
      api,
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        postgresConfigUpdate({
          projectRef: Option.none(),
          config: ["broken=value=again"],
          replaceExistingOverrides: false,
          noRestart: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("PostgresConfigInvalidConfigValueError");
        expect(causeText).toContain("expected config value in key:value format");
      }
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(false);
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("surfaces a PUT 503 as the update unexpected-status error without retrying", () => {
    const out = mockOutput({ format: "text" });
    const api = withProductionRetries(
      mockCommandPlatformApi({
        byMethod: {
          GET: { status: 200, body: { wal_keep_size: "1GB" } },
          PUT: { status: 503, body: {} },
        },
      }),
    );
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        postgresConfigUpdate({
          projectRef: Option.none(),
          config: ["max_connections=100"],
          replaceExistingOverrides: false,
          noRestart: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("PostgresConfigUpdateUnexpectedStatusError");
        expect(causeText).toContain("unexpected update config overrides status 503");
      }
      expect(api.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps initial GET transport failures to the shared get network error", () => {
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({ network: "fail" });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        postgresConfigUpdate({
          projectRef: Option.none(),
          config: [],
          replaceExistingOverrides: false,
          noRestart: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("PostgresConfigGetNetworkError");
        expect(causeText).toContain("failed to retrieve Postgres config overrides");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps PUT transport failures to the update network error", () => {
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({
      byMethod: {
        GET: { status: 200, body: { max_connections: 100 } },
      },
      handler: (request) =>
        request.method === "PUT"
          ? Effect.fail(transportFailure(request))
          : Effect.sync(() => jsonResponse(request, 200, { max_connections: 100 })),
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        postgresConfigUpdate({
          projectRef: Option.none(),
          config: [],
          replaceExistingOverrides: false,
          noRestart: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("PostgresConfigUpdateNetworkError");
        expect(causeText).toContain("failed to update config overrides");
      }
    }).pipe(Effect.provide(layer));
  });
});

describe("postgres-config delete", () => {
  it.effect("uses GET plus PUT and trims keys before deleting", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({
      byMethod: {
        GET: { status: 200, body: { max_connections: 100, shared_buffers: "1GB" } },
        PUT: { status: 200, body: { shared_buffers: "1GB", restart_database: false } },
      },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* postgresConfigDelete({
        projectRef: Option.none(),
        config: [" max_connections "],
        noRestart: true,
      });
      expect(out.progressEvents[0]?.message).toBe("Deleting Postgres config...");
      expect(api.requests).toHaveLength(2);
      expect(api.requests[0]?.method).toBe("GET");
      expect(api.requests[1]?.method).toBe("PUT");
      expect(api.requests[1]?.body).toEqual({
        shared_buffers: "1GB",
        restart_database: false,
      });
      expect(out.stdoutText).toContain("shared_buffers");
      expect(out.stderrText).toBe(
        unverifiedTargetBanner() +
          DELETE_CONFIRMED +
          "- Custom Postgres Config -\n- End of Custom Postgres Config -\n",
      );
      assertPermissionDrift({
        command: "postgres-config delete",
        activeFlags: { config: true, "no-restart": true },
        requests: api.requests,
        exact: true,
      });
      assertBlockDrift(postgresConfigRead, { requests: api.requests.slice(0, 1), exact: true });
      assertBlockDrift(postgresConfigWrite, { requests: api.requests.slice(1, 2), exact: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("picks a project, deletes the override and fills the linked-project cache", () => {
    const { out, api, layer } = composedRuntime({
      stored: { max_connections: 100, shared_buffers: "1GB" },
      updated: { shared_buffers: "1GB" },
    });

    return Effect.gen(function* () {
      yield* postgresConfigDelete({
        projectRef: Option.none(),
        config: ["max_connections"],
        noRestart: false,
      });
      expect(requestLines(api)).toEqual([
        `GET ${PROJECTS_URL}`,
        `GET ${CONFIG_URL}`,
        `PUT ${CONFIG_URL}`,
        `GET ${PROJECT_URL}`,
      ]);
      expect(api.requests[2]?.body).toEqual({ shared_buffers: "1GB" });
      expect(out.stdoutText).toContain("shared_buffers");
      expect(yield* readLinkedProjectCache).toMatchObject({ ref: VALID_REF });
      assertPermissionDrift({
        command: "postgres-config delete",
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("removes a stored override the update contract does not model", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({
      byMethod: {
        GET: { status: 200, body: { max_connections: 100, stored_only_key: "x" } },
        PUT: { status: 200, body: { max_connections: 100 } },
      },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* postgresConfigDelete({
        projectRef: Option.none(),
        config: ["stored_only_key"],
        noRestart: false,
      });
      expect(api.requests[1]?.body).toEqual({ max_connections: 100 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("forwards a stored override the update contract does not model", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({
      byMethod: {
        GET: { status: 200, body: { max_connections: 100, stored_only_key: "x" } },
        PUT: { status: 200, body: { stored_only_key: "x", restart_database: false } },
      },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* postgresConfigDelete({
        projectRef: Option.none(),
        config: ["max_connections"],
        noRestart: true,
      });
      expect(api.requests.map((request) => request.method)).toEqual(["GET", "PUT"]);
      expect(api.requests[1]?.body).toEqual({ stored_only_key: "x", restart_database: false });
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a stream-json success payload", () => {
    const out = mockOutput({ format: "stream-json" });
    const api = mockCommandPlatformApi({
      byMethod: {
        GET: { status: 200, body: { max_connections: 100 } },
        PUT: { status: 200, body: {} },
      },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* postgresConfigDelete({
        projectRef: Option.none(),
        config: ["max_connections"],
        noRestart: false,
      });
      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toEqual({});
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits legacy output modes after the GET plus PUT flow", () =>
    Effect.gen(function* () {
      const cases = [
        {
          outputFlag: "json" as const,
          expected: '"shared_buffers": "1GB"',
        },
        {
          outputFlag: "yaml" as const,
          expected: "shared_buffers: 1GB",
        },
        {
          outputFlag: "toml" as const,
          expected: 'shared_buffers = "1GB"\n',
        },
        {
          outputFlag: "env" as const,
          expected: 'SHARED_BUFFERS="1GB"',
        },
      ];

      for (const testCase of cases) {
        const out = mockOutput({ format: "text" });
        const api = mockCommandPlatformApi({
          byMethod: {
            GET: { status: 200, body: { max_connections: 100, shared_buffers: "1GB" } },
            PUT: { status: 200, body: { shared_buffers: "1GB" } },
          },
        });
        const layer = runtimeWith({ out, api, outputFlag: testCase.outputFlag });
        yield* postgresConfigDelete({
          projectRef: Option.none(),
          config: ["max_connections"],
          noRestart: false,
        }).pipe(Effect.provide(layer));
        expect(out.stdoutText).toContain(testCase.expected);
        expect(out.stderrText).toBe(unverifiedTargetBanner() + DELETE_CONFIRMED);
      }
    }),
  );

  it.effect("flushes telemetry and caches the ref when delete fails after resolution", () => {
    const out = mockOutput({ format: "text" });
    const api = withProductionRetries(
      mockCommandPlatformApi({
        byMethod: {
          GET: { status: 200, body: { max_connections: 100 } },
          PUT: { status: 503, body: {} },
        },
      }),
    );
    const telemetry = mockTelemetryStateTracked();
    const cache = mockLinkedProjectCacheTracked();
    const layer = runtimeWith({
      out,
      api,
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        postgresConfigDelete({
          projectRef: Option.none(),
          config: ["max_connections"],
          noRestart: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("PostgresConfigDeleteUnexpectedStatusError");
      }
      expect(api.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps a non-JSON 2xx PUT body to the delete unmarshal error", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({
      handler: (request) =>
        Effect.sync(() =>
          request.method === "GET"
            ? jsonResponse(request, 200, { max_connections: 100 })
            : textResponse(request, 200, "<html>"),
        ),
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        postgresConfigDelete({
          projectRef: Option.none(),
          config: ["max_connections"],
          noRestart: false,
        }),
      );
      const error = failure(exit);
      expect(error?._tag).toBe("PostgresConfigDeleteUnmarshalError");
      expect(error?.message).toMatch(/^failed to parse delete response: /);
    }).pipe(Effect.provide(layer));
  });

  it.effect("surfaces the shared get error when the initial fetch fails", () => {
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({
      handler: (request) => Effect.sync(() => jsonResponse(request, 503, {})),
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        postgresConfigDelete({
          projectRef: Option.none(),
          config: ["max_connections"],
          noRestart: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("PostgresConfigGetUnexpectedStatusError");
      }
      expect(api.requests.map((request) => request.method)).toEqual(["GET"]);
      assertPermissionDrift({
        command: "postgres-config delete",
        requests: api.requests,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps PUT transport failures to the delete network error", () => {
    const out = mockOutput({ format: "json" });
    const api = mockCommandPlatformApi({
      handler: (request) =>
        request.method === "GET"
          ? Effect.sync(() => jsonResponse(request, 200, { max_connections: 100 }))
          : Effect.fail(transportFailure(request)),
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        postgresConfigDelete({
          projectRef: Option.none(),
          config: ["max_connections"],
          noRestart: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("PostgresConfigDeleteNetworkError");
        expect(causeText).toContain("failed to delete config overrides");
      }
    }).pipe(Effect.provide(layer));
  });
});

describeHostedConsent("postgres-config update", {
  api: {
    byMethod: {
      GET: { status: 200, body: { wal_keep_size: "1GB" } },
      PUT: { status: 200, body: { wal_keep_size: "1GB", max_connections: 100 } },
    },
  },
  invoke: () => ({
    run: postgresConfigUpdate({
      projectRef: Option.some(VALID_REF),
      config: ["max_connections=100"],
      replaceExistingOverrides: false,
      noRestart: false,
    }),
  }),
});

describeHostedConsent("postgres-config delete", {
  api: {
    byMethod: {
      GET: { status: 200, body: { max_connections: 100, shared_buffers: "1GB" } },
      PUT: { status: 200, body: { shared_buffers: "1GB" } },
    },
  },
  invoke: () => ({
    run: postgresConfigDelete({
      projectRef: Option.some(VALID_REF),
      config: ["max_connections"],
      noRestart: false,
    }),
  }),
});
