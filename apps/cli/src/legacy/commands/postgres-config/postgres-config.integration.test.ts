import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  legacyJsonResponse,
  legacyTransportFailure,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../tests/helpers/legacy-mocks.ts";
import { legacyPostgresConfigDelete } from "./delete/delete.handler.ts";
import { legacyPostgresConfigGet } from "./get/get.handler.ts";
import { legacyPostgresConfigUpdate } from "./update/update.handler.ts";

type LegacyOutput = "env" | "pretty" | "json" | "toml" | "yaml";

const tempRoot = useLegacyTempWorkdir("supabase-postgres-config-int-");

function runtimeWith(opts: {
  readonly out: ReturnType<typeof mockOutput>;
  readonly api: ReturnType<typeof mockLegacyPlatformApi>;
  readonly telemetry?: ReturnType<typeof mockLegacyTelemetryStateTracked>["layer"];
  readonly linkedProjectCache?: ReturnType<typeof mockLegacyLinkedProjectCacheTracked>["layer"];
  readonly legacyOutput?: LegacyOutput;
}) {
  return buildLegacyTestRuntime({
    out: opts.out,
    api: opts.api,
    cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
    telemetry: opts.telemetry,
    linkedProjectCache: opts.linkedProjectCache,
    goOutput: opts.legacyOutput === undefined ? Option.none() : Option.some(opts.legacyOutput),
  });
}

describe("legacy postgres-config get", () => {
  it.live("prints the Glamour table with stderr headings in text mode", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      response: { status: 200, body: { max_connections: 100 } },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* legacyPostgresConfigGet({ projectRef: Option.none() });
      expect(out.progressEvents[0]?.message).toBe("Fetching Postgres config...");
      expect(out.stderrText).toBe(
        "- Custom Postgres Config -\n- End of Custom Postgres Config -\n",
      );
      expect(out.stdoutText).toContain("Parameter");
      expect(out.stdoutText).toContain("max_connections");
      expect(out.stdoutText).toContain("100");
      expect(api.requests[0]?.method).toBe("GET");
      expect(api.requests[0]?.url).toContain(
        `/v1/projects/${LEGACY_VALID_REF}/config/database/postgres`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("emits TOML bytes for --output toml", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      response: { status: 200, body: { max_connections: 100 } },
    });
    const layer = runtimeWith({ out, api, legacyOutput: "toml" });

    return Effect.gen(function* () {
      yield* legacyPostgresConfigGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe("max_connections = 100.0\n");
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.live("keeps multi-key pretty and TOML output deterministic", () => {
    const responseBody = {
      wal_keep_size: "1GB",
      max_connections: 100,
      shared_buffers: "128MB",
    };

    return Effect.gen(function* () {
      const prettyOut = mockOutput({ format: "text" });
      const prettyApi = mockLegacyPlatformApi({
        response: { status: 200, body: responseBody },
      });
      yield* legacyPostgresConfigGet({ projectRef: Option.none() }).pipe(
        Effect.provide(runtimeWith({ out: prettyOut, api: prettyApi })),
      );

      expect(prettyOut.stdoutText.indexOf("max_connections")).toBeLessThan(
        prettyOut.stdoutText.indexOf("shared_buffers"),
      );
      expect(prettyOut.stdoutText.indexOf("shared_buffers")).toBeLessThan(
        prettyOut.stdoutText.indexOf("wal_keep_size"),
      );

      const tomlOut = mockOutput({ format: "text" });
      const tomlApi = mockLegacyPlatformApi({
        response: { status: 200, body: responseBody },
      });
      yield* legacyPostgresConfigGet({ projectRef: Option.none() }).pipe(
        Effect.provide(runtimeWith({ out: tomlOut, api: tomlApi, legacyOutput: "toml" })),
      );

      expect(tomlOut.stdoutText).toBe(
        'max_connections = 100.0\nshared_buffers = "128MB"\nwal_keep_size = "1GB"\n',
      );
    });
  });

  it.live("emits env output for --output env", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      response: { status: 200, body: { track_commit_timestamp: true } },
    });
    const layer = runtimeWith({ out, api, legacyOutput: "env" });

    return Effect.gen(function* () {
      yield* legacyPostgresConfigGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe('TRACK_COMMIT_TIMESTAMP="true"\n');
    }).pipe(Effect.provide(layer));
  });

  it.live("emits legacy JSON and YAML bytes", () =>
    Effect.gen(function* () {
      for (const [legacyOutput, expected] of [
        ["json", '"max_connections": 100'],
        ["yaml", "max_connections: 100"],
      ] as const) {
        const out = mockOutput({ format: "text" });
        const api = mockLegacyPlatformApi({
          response: { status: 200, body: { max_connections: 100 } },
        });
        const layer = runtimeWith({ out, api, legacyOutput });
        yield* legacyPostgresConfigGet({ projectRef: Option.none() }).pipe(Effect.provide(layer));
        expect(out.stdoutText).toContain(expected);
        expect(out.stderrText).toBe("");
      }
    }),
  );

  it.live("emits a JSON success payload for --output-format json", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({
      response: { status: 200, body: { max_connections: 100 } },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* legacyPostgresConfigGet({ projectRef: Option.none() });
      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toEqual({ max_connections: 100 });
    }).pipe(Effect.provide(layer));
  });

  it.live("lets the Go --output flag win over --output-format json", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({
      response: { status: 200, body: { max_connections: 100 } },
    });
    const layer = runtimeWith({ out, api, legacyOutput: "toml" });

    return Effect.gen(function* () {
      yield* legacyPostgresConfigGet({ projectRef: Option.none() });
      expect(out.stdoutText).toBe("max_connections = 100.0\n");
      expect(out.messages.some((message) => message.type === "success")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("treats --output pretty as the human-readable table", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      response: { status: 200, body: { max_connections: 100 } },
    });
    const layer = runtimeWith({ out, api, legacyOutput: "pretty" });

    return Effect.gen(function* () {
      yield* legacyPostgresConfigGet({ projectRef: Option.none() });
      expect(out.stderrText).toBe(
        "- Custom Postgres Config -\n- End of Custom Postgres Config -\n",
      );
      expect(out.stdoutText).toContain("Parameter");
      expect(out.stdoutText).toContain("max_connections");
    }).pipe(Effect.provide(layer));
  });

  it.live("maps HTTP 503 to the get unexpected-status error", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 503, body: {} } });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyPostgresConfigGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyPostgresConfigGetUnexpectedStatusError");
        expect(errorJson).toContain("unexpected config overrides status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("maps transport failures to the get network error", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({ network: "fail" });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyPostgresConfigGet({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyPostgresConfigGetNetworkError");
        expect(errorJson).toContain("failed to retrieve Postgres config overrides");
      }
    }).pipe(Effect.provide(layer));
  });
});

describe("legacy postgres-config update", () => {
  it.live(
    "merges current overrides, coerces values, and PUTs arbitrary keys through raw HTTP",
    () => {
      const out = mockOutput({ format: "text" });
      const api = mockLegacyPlatformApi({
        byMethod: {
          GET: { status: 200, body: { wal_keep_size: "1GB" } },
          PUT: {
            status: 200,
            body: {
              wal_keep_size: "1GB",
              max_connections: 100,
              track_commit_timestamp: true,
              statement_timeout: "600",
              custom_key: "alpha",
              restart_database: false,
            },
          },
        },
      });
      const layer = runtimeWith({ out, api });

      return Effect.gen(function* () {
        yield* legacyPostgresConfigUpdate({
          projectRef: Option.none(),
          config: [
            "max_connections=100",
            "track_commit_timestamp=true",
            "statement_timeout=600",
            "custom_key=alpha",
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
          custom_key: "alpha",
          restart_database: false,
        });
        expect(out.stderrText).toBe(
          "- Custom Postgres Config -\n- End of Custom Postgres Config -\n",
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("skips the initial GET in replace mode", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({
      byMethod: {
        PUT: { status: 200, body: { max_connections: 100 } },
      },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* legacyPostgresConfigUpdate({
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
    }).pipe(Effect.provide(layer));
  });

  it.live("emits legacy output modes in replace mode", () =>
    Effect.gen(function* () {
      const cases = [
        {
          legacyOutput: "json" as const,
          expected: '"max_connections": 100',
        },
        {
          legacyOutput: "yaml" as const,
          expected: "max_connections: 100",
        },
        {
          legacyOutput: "toml" as const,
          expected: "max_connections = 100.0\n",
        },
        {
          legacyOutput: "env" as const,
          expected: "MAX_CONNECTIONS=100",
        },
      ];

      for (const testCase of cases) {
        const out = mockOutput({ format: "text" });
        const api = mockLegacyPlatformApi({
          byMethod: {
            PUT: { status: 200, body: { max_connections: 100 } },
          },
        });
        const layer = runtimeWith({ out, api, legacyOutput: testCase.legacyOutput });
        yield* legacyPostgresConfigUpdate({
          projectRef: Option.none(),
          config: ["max_connections=100"],
          replaceExistingOverrides: true,
          noRestart: false,
        }).pipe(Effect.provide(layer));
        expect(out.stdoutText).toContain(testCase.expected);
        expect(out.stderrText).toBe("");
      }
    }),
  );

  it.live("fails before ref resolution on malformed config input", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi();
    const telemetry = mockLegacyTelemetryStateTracked();
    const cache = mockLegacyLinkedProjectCacheTracked();
    const layer = runtimeWith({
      out,
      api,
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyPostgresConfigUpdate({
          projectRef: Option.none(),
          config: ["broken=value=again"],
          replaceExistingOverrides: false,
          noRestart: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyPostgresConfigInvalidConfigValueError");
        expect(errorJson).toContain("expected config value in key:value format");
      }
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(false);
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("maps PUT failures to the update unexpected-status error", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      byMethod: {
        GET: { status: 200, body: { wal_keep_size: "1GB" } },
        PUT: { status: 503, body: {} },
      },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyPostgresConfigUpdate({
          projectRef: Option.none(),
          config: ["max_connections=100"],
          replaceExistingOverrides: false,
          noRestart: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyPostgresConfigUpdateUnexpectedStatusError");
        expect(errorJson).toContain("unexpected update config overrides status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("maps initial GET transport failures to the shared get network error", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({ network: "fail" });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyPostgresConfigUpdate({
          projectRef: Option.none(),
          config: [],
          replaceExistingOverrides: false,
          noRestart: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyPostgresConfigGetNetworkError");
        expect(errorJson).toContain("failed to retrieve Postgres config overrides");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("maps PUT transport failures to the update network error", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({
      byMethod: {
        GET: { status: 200, body: { max_connections: 100 } },
      },
      handler: (request) =>
        request.method === "PUT"
          ? Effect.fail(legacyTransportFailure(request))
          : Effect.sync(() => legacyJsonResponse(request, 200, { max_connections: 100 })),
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyPostgresConfigUpdate({
          projectRef: Option.none(),
          config: [],
          replaceExistingOverrides: false,
          noRestart: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyPostgresConfigUpdateNetworkError");
        expect(errorJson).toContain("failed to update config overrides");
      }
    }).pipe(Effect.provide(layer));
  });
});

describe("legacy postgres-config delete", () => {
  it.live("uses GET plus PUT and trims keys before deleting", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      byMethod: {
        GET: { status: 200, body: { max_connections: 100, shared_buffers: "1GB" } },
        PUT: { status: 200, body: { shared_buffers: "1GB", restart_database: false } },
      },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* legacyPostgresConfigDelete({
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
        "- Custom Postgres Config -\n- End of Custom Postgres Config -\n",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a stream-json success payload", () => {
    const out = mockOutput({ format: "stream-json" });
    const api = mockLegacyPlatformApi({
      byMethod: {
        GET: { status: 200, body: { max_connections: 100 } },
        PUT: { status: 200, body: {} },
      },
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      yield* legacyPostgresConfigDelete({
        projectRef: Option.none(),
        config: ["max_connections"],
        noRestart: false,
      });
      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toEqual({});
    }).pipe(Effect.provide(layer));
  });

  it.live("emits legacy output modes after the GET plus PUT flow", () =>
    Effect.gen(function* () {
      const cases = [
        {
          legacyOutput: "json" as const,
          expected: '"shared_buffers": "1GB"',
        },
        {
          legacyOutput: "yaml" as const,
          expected: "shared_buffers: 1GB",
        },
        {
          legacyOutput: "toml" as const,
          expected: 'shared_buffers = "1GB"\n',
        },
        {
          legacyOutput: "env" as const,
          expected: 'SHARED_BUFFERS="1GB"',
        },
      ];

      for (const testCase of cases) {
        const out = mockOutput({ format: "text" });
        const api = mockLegacyPlatformApi({
          byMethod: {
            GET: { status: 200, body: { max_connections: 100, shared_buffers: "1GB" } },
            PUT: { status: 200, body: { shared_buffers: "1GB" } },
          },
        });
        const layer = runtimeWith({ out, api, legacyOutput: testCase.legacyOutput });
        yield* legacyPostgresConfigDelete({
          projectRef: Option.none(),
          config: ["max_connections"],
          noRestart: false,
        }).pipe(Effect.provide(layer));
        expect(out.stdoutText).toContain(testCase.expected);
        expect(out.stderrText).toBe("");
      }
    }),
  );

  it.live("flushes telemetry and caches the ref when delete fails after resolution", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      byMethod: {
        GET: { status: 200, body: { max_connections: 100 } },
        PUT: { status: 503, body: {} },
      },
    });
    const telemetry = mockLegacyTelemetryStateTracked();
    const cache = mockLegacyLinkedProjectCacheTracked();
    const layer = runtimeWith({
      out,
      api,
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyPostgresConfigDelete({
          projectRef: Option.none(),
          config: ["max_connections"],
          noRestart: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyPostgresConfigDeleteUnexpectedStatusError");
      }
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("surfaces the shared get error when the initial fetch fails", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({
      handler: (request) => Effect.sync(() => legacyJsonResponse(request, 503, {})),
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyPostgresConfigDelete({
          projectRef: Option.none(),
          config: ["max_connections"],
          noRestart: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyPostgresConfigGetUnexpectedStatusError");
      }
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.method).toBe("GET");
    }).pipe(Effect.provide(layer));
  });

  it.live("maps PUT transport failures to the delete network error", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({
      handler: (request) =>
        request.method === "GET"
          ? Effect.sync(() => legacyJsonResponse(request, 200, { max_connections: 100 }))
          : Effect.fail(legacyTransportFailure(request)),
    });
    const layer = runtimeWith({ out, api });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyPostgresConfigDelete({
          projectRef: Option.none(),
          config: ["max_connections"],
          noRestart: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyPostgresConfigDeleteNetworkError");
        expect(errorJson).toContain("failed to delete config overrides");
      }
    }).pipe(Effect.provide(layer));
  });
});
