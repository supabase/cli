import { BunServices } from "@effect/platform-bun";
import { type V1GetSslEnforcementConfigOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path, Schema } from "effect";
import { describeHostedConsent } from "../../../../tests/helpers/hosted-consent.ts";
import { describeHostedTargetSelection } from "../../../../tests/helpers/hosted-target-selection.ts";
import { mockOutput, mockTty } from "../../../../tests/helpers/mocks.ts";
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
import { YesFlag } from "../../../command-internal/global-flags.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  projectResponse,
  realLinkedProjectCache,
} from "../../../../tests/helpers/permission-real-layers.ts";
import { sslEnforcementUpdate } from "./update.handler.ts";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const SSL_ENFORCED: typeof V1GetSslEnforcementConfigOutput.Type = {
  currentConfig: { database: true },
  appliedSuccessfully: true,
};

const SSL_NOT_ENFORCED: typeof V1GetSslEnforcementConfigOutput.Type = {
  currentConfig: { database: false },
  appliedSuccessfully: false,
};

const SSL_DESIRED_BUT_NOT_APPLIED: typeof V1GetSslEnforcementConfigOutput.Type = {
  currentConfig: { database: true },
  appliedSuccessfully: false,
};

const consentApproved = Layer.mergeAll(
  Layer.succeed(YesFlag, true),
  Layer.succeed(TargetPolicy, { group: "hosted", consent: "no" }),
);

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  outputFlag?: "env" | "pretty" | "json" | "toml" | "yaml";
  response?: typeof V1GetSslEnforcementConfigOutput.Type;
  status?: number;
  network?: "fail";
}

const tempRoot = useTempWorkdir("supabase-ssl-enforcement-update-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? SSL_ENFORCED },
    network: opts.network,
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api,
      cliSettings,
      outputFlag: opts.outputFlag === undefined ? Option.none() : Option.some(opts.outputFlag),
    }),
    consentApproved,
  );
  return { layer, out, api };
}

function setupTracked(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockCommandPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? SSL_ENFORCED },
    network: opts.network,
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api,
      cliSettings,
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
    }),
    consentApproved,
  );
  return { layer, out, api, telemetry, cache };
}

describe("ssl-enforcement update integration", () => {
  it.effect("fails with SslEnforcementNoEnableDisableFlagError when neither flag is set", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        sslEnforcementUpdate({
          remote: Option.none(),
          projectRef: Option.none(),
          enableDbSslEnforcement: false,
          disableDbSslEnforcement: false,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("SslEnforcementNoEnableDisableFlagError");
        expect(causeText).toContain("enable/disable not specified");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with SslEnforcementMutuallyExclusiveFlagsError when both flags are set", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        sslEnforcementUpdate({
          remote: Option.none(),
          projectRef: Option.none(),
          enableDbSslEnforcement: true,
          disableDbSslEnforcement: true,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("SslEnforcementMutuallyExclusiveFlagsError");
        expect(causeText).toContain(
          "if any flags in the group [enable-db-ssl-enforcement disable-db-ssl-enforcement] are set",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not call the API when flag validation fails", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* Effect.exit(
        sslEnforcementUpdate({
          remote: Option.none(),
          projectRef: Option.none(),
          enableDbSslEnforcement: false,
          disableDbSslEnforcement: false,
        }),
      );
      expect(api.requests).toHaveLength(0);
      expect(() =>
        assertPermissionDrift({
          command: "ssl-enforcement update",
          activeFlags: { "enable-db-ssl-enforcement": false, "disable-db-ssl-enforcement": false },
          requests: [
            {
              method: "PUT",
              url: `https://api.supabase.com/v1/projects/${VALID_REF}/ssl-enforcement`,
            },
          ],
        }),
      ).toThrow(/condition doesn't hold/);
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes telemetry but NOT linked-project cache when validation fails", () => {
    const { layer, telemetry, cache } = setupTracked();
    return Effect.gen(function* () {
      yield* Effect.exit(
        sslEnforcementUpdate({
          remote: Option.none(),
          projectRef: Option.none(),
          enableDbSslEnforcement: false,
          disableDbSslEnforcement: false,
        }),
      );
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("sends requestedConfig.database = true when --enable-db-ssl-enforcement is set", () => {
    const { layer, api } = setup({ response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* sslEnforcementUpdate({
        remote: Option.none(),
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.body).toMatchObject({
        requestedConfig: { database: true },
      });
      assertPermissionDrift({
        command: "ssl-enforcement update",
        activeFlags: { "enable-db-ssl-enforcement": true, "disable-db-ssl-enforcement": false },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists projects for the picker and fills the real linked-project cache", () => {
    const out = mockOutput({ promptSelectResponses: [VALID_REF] });
    const api = mockCommandPlatformApi({
      handler: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/v1/projects") {
          return Effect.succeed(jsonResponse(request, 200, [projectResponse(VALID_REF)]));
        }
        if (path === `/v1/projects/${VALID_REF}`) {
          return Effect.succeed(jsonResponse(request, 200, projectResponse(VALID_REF)));
        }
        if (path === `/v1/projects/${VALID_REF}/ssl-enforcement`) {
          return Effect.succeed(jsonResponse(request, 200, SSL_ENFORCED));
        }
        return Effect.succeed(jsonResponse(request, 404, { message: "unexpected request" }));
      },
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
        linkedProjectCache: realLinkedProjectCache({
          httpClient: api.httpClientLayer,
          cliSettings,
        }),
      }),
      consentApproved,
    );
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* sslEnforcementUpdate({
        remote: Option.none(),
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        "GET https://api.supabase.com/v1/projects",
        `PUT https://api.supabase.com/v1/projects/${VALID_REF}/ssl-enforcement`,
        `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
      ]);
      expect(api.requests[1]?.body).toMatchObject({ requestedConfig: { database: true } });
      expect(out.stdoutText).toBe("SSL is being enforced.\n");
      const cachePath = `${tempRoot.current}/supabase/.temp/linked-project.json`;
      expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
        ref: VALID_REF,
      });
      assertPermissionDrift({
        command: "ssl-enforcement update",
        activeFlags: { "enable-db-ssl-enforcement": true, "disable-db-ssl-enforcement": false },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "sends requestedConfig.database = false when --disable-db-ssl-enforcement is set",
    () => {
      const { layer, api } = setup({ response: SSL_NOT_ENFORCED });
      return Effect.gen(function* () {
        yield* sslEnforcementUpdate({
          remote: Option.none(),
          projectRef: Option.none(),
          enableDbSslEnforcement: false,
          disableDbSslEnforcement: true,
        });
        expect(api.requests).toHaveLength(1);
        expect(api.requests[0]?.body).toMatchObject({
          requestedConfig: { database: false },
        });
        assertPermissionDrift({
          command: "ssl-enforcement update",
          activeFlags: { "enable-db-ssl-enforcement": false, "disable-db-ssl-enforcement": true },
          requests: api.requests,
          exact: true,
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    'prints "SSL is being enforced." when database=true and appliedSuccessfully=true',
    () => {
      const { layer, out } = setup({ response: SSL_ENFORCED });
      return Effect.gen(function* () {
        yield* sslEnforcementUpdate({
          remote: Option.none(),
          projectRef: Option.none(),
          enableDbSslEnforcement: true,
          disableDbSslEnforcement: false,
        });
        expect(out.stdoutText).toBe("SSL is being enforced.\n");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect('prints "SSL is *NOT* being enforced." when database=false', () => {
    const { layer, out } = setup({ response: SSL_NOT_ENFORCED });
    return Effect.gen(function* () {
      yield* sslEnforcementUpdate({
        remote: Option.none(),
        projectRef: Option.none(),
        enableDbSslEnforcement: false,
        disableDbSslEnforcement: true,
      });
      expect(out.stdoutText).toBe("SSL is *NOT* being enforced.\n");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    'prints "SSL is *NOT* being enforced." when database=true but appliedSuccessfully=false',
    () => {
      const { layer, out } = setup({ response: SSL_DESIRED_BUT_NOT_APPLIED });
      return Effect.gen(function* () {
        yield* sslEnforcementUpdate({
          remote: Option.none(),
          projectRef: Option.none(),
          enableDbSslEnforcement: true,
          disableDbSslEnforcement: false,
        });
        expect(out.stdoutText).toBe("SSL is *NOT* being enforced.\n");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("emits env output for --output env (exact bytes)", () => {
    const { layer, out } = setup({ outputFlag: "env", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* sslEnforcementUpdate({
        remote: Option.none(),
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(out.stdoutText).toBe('APPLIEDSUCCESSFULLY="true"\nCURRENTCONFIG_DATABASE="true"\n');
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits indented JSON for --output json (exact bytes)", () => {
    const { layer, out } = setup({ outputFlag: "json", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* sslEnforcementUpdate({
        remote: Option.none(),
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(out.stdoutText).toBe(
        `{
  "appliedSuccessfully": true,
  "currentConfig": {
    "database": true
  }
}
`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits YAML for --output yaml", () => {
    const { layer, out } = setup({ outputFlag: "yaml", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* sslEnforcementUpdate({
        remote: Option.none(),
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(out.stdoutText).toContain("appliedsuccessfully: true");
      expect(out.stdoutText).toContain("database: true");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits TOML for --output toml", () => {
    const { layer, out } = setup({ outputFlag: "toml", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* sslEnforcementUpdate({
        remote: Option.none(),
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(out.stdoutText).toContain("AppliedSuccessfully = true");
      expect(out.stdoutText).toContain("[CurrentConfig]");
    }).pipe(Effect.provide(layer));
  });

  it.effect("treats --output pretty as identical to text mode", () => {
    const { layer, out } = setup({ outputFlag: "pretty", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* sslEnforcementUpdate({
        remote: Option.none(),
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(out.stdoutText).toBe("SSL is being enforced.\n");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a JSON success event when --output-format=json", () => {
    const { layer, out } = setup({ format: "json", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* sslEnforcementUpdate({
        remote: Option.none(),
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({
        currentConfig: { database: true },
        appliedSuccessfully: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a result event for --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* sslEnforcementUpdate({
        remote: Option.none(),
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ currentConfig: { database: true } });
    }).pipe(Effect.provide(layer));
  });

  it.effect("--output wins over --output-format when both provided", () => {
    const { layer, out } = setup({ format: "json", outputFlag: "yaml", response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* sslEnforcementUpdate({
        remote: Option.none(),
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(out.stdoutText).toContain("appliedsuccessfully: true");
      expect(out.stdoutText.startsWith("{")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes the resolved project ref into the updateSslEnforcementConfig URL", () => {
    const { layer, api } = setup({ response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* sslEnforcementUpdate({
        remote: Option.none(),
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toContain(`/v1/projects/${VALID_REF}/ssl-enforcement`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses the --remote=<ref> value over CommandSettings.projectId", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup({ response: SSL_ENFORCED });
    return Effect.gen(function* () {
      yield* sslEnforcementUpdate({
        remote: Option.some({ _tag: "Ref", ref: flagRef }),
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${flagRef}/`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads supabase/.temp/project-ref when env and flag are unset", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const localTempRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-ssl-update-int-fileref-",
      });
      const path = yield* Path.Path;
      const fileRef = "filerefabcdefghijklm";
      yield* fs.makeDirectory(path.join(localTempRoot, "supabase", ".temp"), { recursive: true });
      yield* fs.writeFileString(
        path.join(localTempRoot, "supabase", ".temp", "project-ref"),
        fileRef,
      );

      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi({ response: { status: 200, body: SSL_ENFORCED } });
      const cliSettings = mockCommandSettings({
        workdir: localTempRoot,
        projectId: Option.none(),
      });
      const layer = Layer.mergeAll(buildTestRuntime({ out, api, cliSettings }), consentApproved);

      yield* sslEnforcementUpdate({
        remote: Option.none(),
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      }).pipe(Effect.provide(layer));
      expect(api.requests[0]?.url).toContain(`/v1/projects/${fileRef}/`);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("fails with ProjectRefNotLinkedError when no ref source matches off-TTY", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const localTempRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-ssl-update-int-no-ref-",
      });
      const out = mockOutput({ format: "text" });
      const api = mockCommandPlatformApi({ response: { status: 200, body: SSL_ENFORCED } });
      const cliSettings = mockCommandSettings({
        workdir: localTempRoot,
        projectId: Option.none(),
      });
      const layer = Layer.mergeAll(buildTestRuntime({ out, api, cliSettings }), consentApproved);

      const exit = yield* Effect.exit(
        sslEnforcementUpdate({
          remote: Option.none(),
          projectRef: Option.none(),
          enableDbSslEnforcement: true,
          disableDbSslEnforcement: false,
        }).pipe(Effect.provide(layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("ProjectRefNotLinkedError");
      }
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("fails with InvalidProjectRefError when the resolved ref is malformed", () => {
    const out = mockOutput({ format: "text" });
    const api = mockCommandPlatformApi({ response: { status: 200, body: SSL_ENFORCED } });
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out,
        api,
        cliSettings: mockCommandSettings({
          workdir: tempRoot.current,
          projectId: Option.some("BADREF"),
        }),
      }),
      consentApproved,
    );
    return Effect.gen(function* () {
      const error = yield* sslEnforcementUpdate({
        remote: Option.none(),
        projectRef: Option.none(),
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "InvalidProjectRefError" });
      expect(api.requests).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  describeHostedTargetSelection("ssl-enforcement update", {
    operands: ["--enable-db-ssl-enforcement"],
    activeFlags: { "enable-db-ssl-enforcement": true, "disable-db-ssl-enforcement": false },
    respond: (request) => Effect.succeed(jsonResponse(request, 200, SSL_ENFORCED)),
    run: (flags) =>
      sslEnforcementUpdate({
        ...flags,
        enableDbSslEnforcement: true,
        disableDbSslEnforcement: false,
      }),
  });
});

describeHostedConsent("ssl-enforcement update", {
  api: {
    response: {
      status: 200,
      body: { currentConfig: { database: true }, appliedSuccessfully: true },
    },
  },
  invoke: () => ({
    run: sslEnforcementUpdate({
      remote: Option.some({ _tag: "Ref", ref: VALID_REF }),
      projectRef: Option.none(),
      enableDbSslEnforcement: true,
      disableDbSslEnforcement: false,
    }),
  }),
});
