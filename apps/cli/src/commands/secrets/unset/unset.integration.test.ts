import { type V1ListAllSecretsOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Schema } from "effect";

import { YesFlag } from "../../../command-internal/global-flags.ts";
import {
  HostedMutationConsentRequiredError,
  HostedMutationDeclinedError,
} from "../../../command-internal/hosted-consent/hosted-consent.errors.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { ProjectRefNotLinkedError } from "../../../config/project-ref.errors.ts";
import { describeHostedConsent } from "../../../../tests/helpers/hosted-consent.ts";
import { mockOutput, mockStdin, mockTty } from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  buildTestRuntime,
  jsonResponse,
  transportFailure,
  mockCommandSettings,
  mockCommandPlatformApi,
  useTempWorkdir,
  withConfigEnv,
  unverifiedTargetBanner,
} from "../../../../tests/helpers/command-mocks.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  projectResponse,
  realLinkedProjectCache,
} from "../../../../tests/helpers/permission-real-layers.ts";
import { SecretsNoArgumentsError, SecretsUnsetInputError } from "../secrets.errors.ts";
import type { SecretsUnsetFlags } from "./unset.command.ts";
import { secretsUnset } from "./unset.handler.ts";

type SecretsList = typeof V1ListAllSecretsOutput.Type;

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  outputFlag?: "pretty" | "json" | "yaml" | "toml" | "env";
  interactive?: boolean;
  unlinked?: boolean;
  yes?: boolean;
  stdinIsTty?: boolean;
  /** Piped stdin lines a non-TTY confirm read would consume. */
  stdinInput?: string;
  confirm?: boolean;
  list?: SecretsList;
  listStatus?: number;
  listNetwork?: "fail";
  deleteStatus?: number;
  deleteNetwork?: "fail";
}

const tempRoot = useTempWorkdir("supabase-secrets-unset-int-");

const MIXED_SECRETS: SecretsList = [
  { name: "FOO", value: "d1" },
  { name: "SUPABASE_AUTH_TOKEN", value: "d2" },
  { name: "BAR", value: "d3" },
];

const ON_TARGET = `project ${VALID_REF}`;

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    interactive: opts.interactive,
    confirmLogout: opts.confirm,
  });
  // GET = list, DELETE = unset. Each branch supports its own status/network
  // override via the `handler` escape hatch.
  const api = mockCommandPlatformApi({
    handler: (request) => {
      if (request.method === "GET") {
        if (opts.listNetwork === "fail") {
          return Effect.fail(transportFailure(request));
        }
        return Effect.succeed(jsonResponse(request, opts.listStatus ?? 200, opts.list ?? []));
      }
      if (opts.deleteNetwork === "fail") {
        return Effect.fail(transportFailure(request));
      }
      return Effect.succeed(jsonResponse(request, opts.deleteStatus ?? 200, null));
    },
  });
  const cliSettings = mockCommandSettings({
    workdir: tempRoot.current,
    projectId: opts.unlinked ? Option.none() : undefined,
  });
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api,
      cliSettings,
      tty: mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
      stdin: mockStdin(opts.stdinIsTty ?? false, opts.stdinInput),
      outputFlag: opts.outputFlag === undefined ? Option.none() : Option.some(opts.outputFlag),
    }),
    Layer.succeed(YesFlag, opts.yes ?? false),
    Layer.succeed(TargetPolicy, { group: "hosted", consent: "no" }),
  );
  return { layer, out, api };
}

const unset = (flags: Partial<SecretsUnsetFlags> = {}) =>
  secretsUnset({ projectRef: Option.none(), names: [], all: false, dryRun: false, ...flags });

const methods = (api: { requests: ReadonlyArray<{ method: string }> }) =>
  api.requests.map((r) => r.method);

describe("secrets unset integration", () => {
  describe("usage errors", () => {
    it.effect.each([
      {
        name: "no names and no --all",
        flags: { names: [] },
        expected: { _tag: "SecretsNoArgumentsError", suggestion: expect.stringContaining("--all") },
        errorClass: SecretsNoArgumentsError,
      },
      {
        name: "names together with --all",
        flags: { names: ["FOO"], all: true },
        expected: { _tag: "SecretsUnsetInputError" },
        errorClass: SecretsUnsetInputError,
      },
    ])("fails on $name before the project ref resolves", ({ flags, expected, errorClass }) => {
      const { layer, api } = setup({ yes: true, unlinked: true, list: MIXED_SECRETS });
      return Effect.gen(function* () {
        const unlinkedError = yield* unset({ names: ["FOO"] }).pipe(Effect.flip);
        expect(unlinkedError).toBeInstanceOf(ProjectRefNotLinkedError);

        const error = yield* unset(flags).pipe(Effect.flip);
        expect(error).toBeInstanceOf(errorClass);
        expect(error).toMatchObject(expected);
        expect(error.message).toContain("Nothing was unset");
        expect(api.requests).toEqual([]);
      }).pipe(Effect.provide(layer));
    });
  });

  describe("unsetting named secrets", () => {
    it.effect("sends one DELETE with the names and echoes the confirmation for --yes", () => {
      const { layer, out, api } = setup({ yes: true });
      return Effect.gen(function* () {
        yield* unset({ names: ["FOO", "BAR"] });
        expect(methods(api)).toEqual(["DELETE"]);
        expect(api.requests[0]?.body).toEqual(["FOO", "BAR"]);
        expect(out.stderrText).toBe(
          `${unverifiedTargetBanner()}Confirmed by --yes: unset 2 secrets on ${ON_TARGET}\n`,
        );
        expect(out.stdoutText).toBe("Finished supabase secrets unset.\n");
        assertPermissionDrift({
          command: "secrets unset",
          activeFlags: { all: false, "dry-run": false },
          requests: api.requests,
          exact: true,
        });
      }).pipe(Effect.provide(layer));
    });

    it.effect("treats SUPABASE_YES=1 in the environment like --yes", () => {
      const { layer, out, api } = setup();
      // Inner provide so the layer builds inside the pinned-env sandbox.
      return withConfigEnv(
        { SUPABASE_YES: "1" },
        Effect.gen(function* () {
          yield* unset({ names: ["FOO"] });
          expect(out.stderrText).toBe(
            `${unverifiedTargetBanner()}Confirmed by --yes: unset 1 secret on ${ON_TARGET}\n`,
          );
          expect(methods(api)).toEqual(["DELETE"]);
        }).pipe(Effect.provide(layer)),
      );
    });

    it.effect("prompts on a TTY with a default of No and unsets when the user accepts", () => {
      const { layer, out, api } = setup({ stdinIsTty: true, confirm: true });
      return Effect.gen(function* () {
        yield* unset({ names: ["FOO"] });
        expect(out.promptConfirmCalls).toEqual([
          { message: `unset 1 secret on ${ON_TARGET}?`, opts: { defaultValue: false } },
        ]);
        expect(out.stderrText).toContain("Secrets to unset:\n • FOO\n");
        expect(methods(api)).toEqual(["DELETE"]);
        expect(api.requests[0]?.body).toEqual(["FOO"]);
        expect(out.stdoutText).toBe("Finished supabase secrets unset.\n");
      }).pipe(Effect.provide(layer));
    });

    it.effect(
      "fails with HostedMutationDeclinedError and sends no DELETE when the user declines",
      () => {
        const { layer, api } = setup({ stdinIsTty: true, confirm: false });
        return Effect.gen(function* () {
          const error = yield* unset({ names: ["FOO"] }).pipe(Effect.flip);
          expect(error).toBeInstanceOf(HostedMutationDeclinedError);
          expect(api.requests).toEqual([]);
        }).pipe(Effect.provide(layer));
      },
    );
  });

  it.effect("lists projects for the picker and fills the real linked-project cache", () => {
    const out = mockOutput({ promptSelectResponses: [VALID_REF] });
    const projectUrl = `https://api.supabase.com/v1/projects/${VALID_REF}`;
    const api = mockCommandPlatformApi({
      handler: (request) => {
        if (request.url === "https://api.supabase.com/v1/projects") {
          return Effect.succeed(jsonResponse(request, 200, [projectResponse(VALID_REF)]));
        }
        if (request.url === projectUrl) {
          return Effect.succeed(jsonResponse(request, 200, projectResponse(VALID_REF)));
        }
        if (request.url === `${projectUrl}/secrets` && request.method === "GET") {
          return Effect.succeed(
            jsonResponse(request, 200, [
              { name: "FOO", value: "d1" },
              { name: "SUPABASE_AUTH_TOKEN", value: "d2" },
            ]),
          );
        }
        return Effect.succeed(jsonResponse(request, 200, null));
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
        tty: mockTty({ stdinIsTty: true, stdoutIsTty: false }),
        linkedProjectCache: realLinkedProjectCache({
          httpClient: api.httpClientLayer,
          cliSettings,
        }),
      }),
      Layer.succeed(YesFlag, true),
      Layer.succeed(TargetPolicy, { group: "hosted", consent: "no" }),
    );
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cachePath = `${tempRoot.current}/supabase/.temp/linked-project.json`;
      expect(yield* fs.exists(cachePath)).toBe(false);
      yield* unset({ all: true });
      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        "GET https://api.supabase.com/v1/projects",
        `GET ${projectUrl}/secrets`,
        `DELETE ${projectUrl}/secrets`,
        `GET ${projectUrl}`,
      ]);
      expect(api.requests[2]?.body).toEqual(["FOO"]);
      expect(out.stdoutText).toBe("Finished supabase secrets unset.\n");
      expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
        ref: VALID_REF,
      });
      assertPermissionDrift({
        command: "secrets unset",
        activeFlags: { all: true, "dry-run": false },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  describe("--all", () => {
    it.effect("lists once, then DELETEs only the non-SUPABASE_ secrets", () => {
      const { layer, out, api } = setup({ yes: true, list: MIXED_SECRETS });
      return Effect.gen(function* () {
        yield* unset({ all: true });
        expect(methods(api)).toEqual(["GET", "DELETE"]);
        expect(api.requests[1]?.body).toEqual(["FOO", "BAR"]);
        assertPermissionDrift({
          command: "secrets unset",
          activeFlags: { all: true, "dry-run": false },
          requests: api.requests,
          exact: true,
        });
        expect(out.stderrText).toBe(
          `${unverifiedTargetBanner()}Confirmed by --yes: unset 2 secrets on ${ON_TARGET}\n`,
        );
      }).pipe(Effect.provide(layer));
    });

    it.effect.each([
      { name: "only SUPABASE_ secrets", list: [{ name: "SUPABASE_ONLY", value: "d" }] },
      { name: "no secrets", list: [] },
    ])("writes a stderr no-op and sends no DELETE when the project has $name", ({ list }) => {
      const { layer, out, api } = setup({ yes: true, list });
      return Effect.gen(function* () {
        yield* unset({ all: true });
        expect(out.stderrText).toBe(
          unverifiedTargetBanner() + "You have not set any function secrets, nothing to do.\n",
        );
        expect(out.stdoutText).toBe("");
        expect(methods(api)).toEqual(["GET"]);
      }).pipe(Effect.provide(layer));
    });
  });

  describe("consent gate", () => {
    it.effect.each([
      { name: "named secrets", flags: { names: ["FOO"] }, expectedMethods: [] },
      { name: "--all", flags: { all: true }, expectedMethods: ["GET"] },
    ])(
      "refuses $name on a non-TTY run without --yes and sends no DELETE",
      ({ flags, expectedMethods }) => {
        const { layer, out, api } = setup({ list: MIXED_SECRETS });
        return Effect.gen(function* () {
          const error = yield* unset(flags).pipe(Effect.flip);
          expect(error).toBeInstanceOf(HostedMutationConsentRequiredError);
          expect(error).toMatchObject({
            message: expect.stringContaining(VALID_REF),
            suggestion: expect.stringContaining("--yes"),
          });
          expect(methods(api)).toEqual(expectedMethods);
          expect(out.stderrText).toBe(unverifiedTargetBanner());
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect("still refuses a piped `y` without --yes and sends no DELETE", () => {
      const { layer, out, api } = setup({ stdinIsTty: false, stdinInput: "y\n" });
      return Effect.gen(function* () {
        const error = yield* unset({ names: ["FOO"] }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(HostedMutationConsentRequiredError);
        expect(api.requests).toEqual([]);
        expect(out.stderrText).toBe(unverifiedTargetBanner());
      }).pipe(Effect.provide(layer));
    });

    it.effect.each(["json", "stream-json"] as const)(
      "refuses --output-format %s without --yes even on a TTY",
      (format) => {
        const { layer, out, api } = setup({ format, stdinIsTty: true });
        return Effect.gen(function* () {
          const error = yield* unset({ names: ["FOO"] }).pipe(Effect.flip);
          expect(error).toBeInstanceOf(HostedMutationConsentRequiredError);
          expect(api.requests).toEqual([]);
          expect(out.promptConfirmCalls).toEqual([]);
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect("refuses text output that is not interactive even on a TTY stdin", () => {
      const { layer, out, api } = setup({ stdinIsTty: true, interactive: false });
      return Effect.gen(function* () {
        const error = yield* unset({ names: ["FOO"] }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(HostedMutationConsentRequiredError);
        expect(api.requests).toEqual([]);
        expect(out.promptConfirmCalls).toEqual([]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("lists every secret --all will unset before asking", () => {
      const { layer, out } = setup({ stdinIsTty: true, confirm: false, list: MIXED_SECRETS });
      return Effect.gen(function* () {
        yield* unset({ all: true }).pipe(Effect.flip);
        expect(out.stderrText).toContain("Secrets to unset:\n • FOO\n • BAR\n");
        expect(out.stderrText).not.toContain("SUPABASE_AUTH_TOKEN");
      }).pipe(Effect.provide(layer));
    });
  });

  describe("--dry-run", () => {
    it.effect("lists the named secrets with the project ref and makes no request", () => {
      const { layer, out, api } = setup();
      return Effect.gen(function* () {
        yield* unset({ names: ["FOO", "BAR"], dryRun: true });
        expect(out.stdoutText).toBe(
          `Would unset these function secrets from project ${VALID_REF}:\n • FOO\n • BAR\n`,
        );
        expect(out.stderrText).toBe(unverifiedTargetBanner());
        expect(api.requests).toEqual([]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("never DELETEs when --yes is passed as well", () => {
      const { layer, out, api } = setup({ yes: true });
      return Effect.gen(function* () {
        yield* unset({ names: ["FOO"], dryRun: true });
        expect(out.stdoutText).toBe(
          `Would unset these function secrets from project ${VALID_REF}:\n • FOO\n`,
        );
        expect(api.requests).toEqual([]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("with --all issues only the GET and lists the non-SUPABASE_ names", () => {
      const { layer, out, api } = setup({ list: MIXED_SECRETS });
      return Effect.gen(function* () {
        yield* unset({ all: true, dryRun: true });
        expect(methods(api)).toEqual(["GET"]);
        expect(out.stdoutText).toBe(
          `Would unset these function secrets from project ${VALID_REF}:\n • FOO\n • BAR\n`,
        );
      }).pipe(Effect.provide(layer));
    });

    it.effect("emits a dry_run success payload in json and makes no request", () => {
      const { layer, out, api } = setup({ format: "json" });
      return Effect.gen(function* () {
        yield* unset({ names: ["FOO", "BAR"], dryRun: true });
        const successes = out.messages.filter((m) => m.type === "success");
        expect(successes).toEqual([
          {
            type: "success",
            message: "Dry run: no secrets were unset.",
            data: { project_ref: VALID_REF, count: 2, names: ["FOO", "BAR"], dry_run: true },
          },
        ]);
        expect(api.requests).toEqual([]);
      }).pipe(Effect.provide(layer));
    });
  });

  describe("machine-readable output", () => {
    it.effect.each(["json", "stream-json"] as const)(
      "emits names and dry_run: false for --output-format %s",
      (format) => {
        const { layer, out, api } = setup({ yes: true, format });
        return Effect.gen(function* () {
          yield* unset({ names: ["FOO", "BAR"] });
          const successes = out.messages.filter((m) => m.type === "success");
          expect(successes).toEqual([
            {
              type: "success",
              message: "Finished supabase secrets unset.",
              data: { project_ref: VALID_REF, count: 2, names: ["FOO", "BAR"], dry_run: false },
            },
          ]);
          expect(methods(api)).toEqual(["DELETE"]);
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect.each([
      { format: "json", dryRun: false },
      { format: "stream-json", dryRun: true },
    ] as const)(
      "emits an empty result for $format when --all finds nothing (dryRun: $dryRun)",
      ({ format, dryRun }) => {
        const { layer, out, api } = setup({
          yes: true,
          format,
          list: [{ name: "SUPABASE_ONLY", value: "d" }],
        });
        return Effect.gen(function* () {
          yield* unset({ all: true, dryRun });
          const successes = out.messages.filter((m) => m.type === "success");
          expect(successes).toEqual([
            {
              type: "success",
              message: "You have not set any function secrets, nothing to do.",
              data: { project_ref: VALID_REF, count: 0, names: [], dry_run: dryRun },
            },
          ]);
          expect(out.stderrText).toBe(unverifiedTargetBanner());
          expect(methods(api)).toEqual(["GET"]);
        }).pipe(Effect.provide(layer));
      },
    );

    it.effect("prints the text Finished line regardless of the --output value", () => {
      const { layer, out } = setup({ yes: true, outputFlag: "json" });
      return Effect.gen(function* () {
        yield* unset({ names: ["FOO"] });
        expect(out.stdoutText).toBe("Finished supabase secrets unset.\n");
      }).pipe(Effect.provide(layer));
    });
  });

  describe("API failures", () => {
    it.effect("fails with SecretsListNetworkError on GET failure (--all)", () => {
      const { layer } = setup({ yes: true, listNetwork: "fail" });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(unset({ all: true }));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("SecretsListNetworkError");
        }
      }).pipe(Effect.provide(layer));
    });

    it.effect("fails with SecretsListUnexpectedStatusError on GET 503 (--all)", () => {
      const { layer } = setup({ yes: true, listStatus: 503 });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(unset({ all: true }));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("SecretsListUnexpectedStatusError");
        }
      }).pipe(Effect.provide(layer));
    });

    it.effect("fails with SecretsUnsetNetworkError on DELETE transport failure", () => {
      const { layer } = setup({ yes: true, deleteNetwork: "fail" });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(unset({ names: ["FOO"] }));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain("SecretsUnsetNetworkError");
          expect(causeText).toContain("failed to delete secrets");
        }
      }).pipe(Effect.provide(layer));
    });

    it.effect("fails with SecretsUnsetUnexpectedStatusError on DELETE 500", () => {
      const { layer } = setup({ yes: true, deleteStatus: 500 });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(unset({ names: ["FOO"] }));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain("SecretsUnsetUnexpectedStatusError");
          expect(causeText).toContain("Unexpected error unsetting project secrets");
        }
      }).pipe(Effect.provide(layer));
    });
  });
});

describeHostedConsent("secrets unset", {
  api: { response: { status: 200, body: null } },
  invoke: () => ({
    run: secretsUnset({ projectRef: Option.none(), names: ["FOO"], all: false, dryRun: false }),
  }),
});
