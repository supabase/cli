import { type V1ListAllSecretsOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";

import { LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { mockOutput, mockStdin, mockTty } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  legacyJsonResponse,
  legacyTransportFailure,
  mockLegacyCliConfig,
  mockLegacyPlatformApi,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacySecretsUnset } from "./unset.handler.ts";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

type SecretsList = typeof V1ListAllSecretsOutput.Type;

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "pretty" | "json" | "yaml" | "toml" | "env";
  yes?: boolean;
  stdinIsTty?: boolean;
  /** Piped stdin lines consumed by the non-TTY confirm read. */
  stdinInput?: string;
  confirm?: boolean;
  list?: SecretsList;
  listStatus?: number;
  listNetwork?: "fail";
  deleteStatus?: number;
  deleteNetwork?: "fail";
}

const tempRoot = useLegacyTempWorkdir("supabase-secrets-unset-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    confirmLogout: opts.confirm,
  });
  // GET = list, DELETE = unset. Each branch supports its own status/network
  // override via the `handler` escape hatch.
  const api = mockLegacyPlatformApi({
    handler: (request) => {
      if (request.method === "GET") {
        if (opts.listNetwork === "fail") {
          return Effect.fail(legacyTransportFailure(request));
        }
        return Effect.succeed(legacyJsonResponse(request, opts.listStatus ?? 200, opts.list ?? []));
      }
      if (opts.deleteNetwork === "fail") {
        return Effect.fail(legacyTransportFailure(request));
      }
      return Effect.succeed(legacyJsonResponse(request, opts.deleteStatus ?? 200, null));
    },
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({
      out,
      api,
      cliConfig,
      tty: mockTty({ stdinIsTty: opts.stdinIsTty ?? false, stdoutIsTty: false }),
      stdin: mockStdin(opts.stdinIsTty ?? false, opts.stdinInput),
      goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
    }),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
  );
  return { layer, out, api };
}

function parseDeleteBody(body: unknown): string[] {
  return body as string[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("legacy secrets unset integration", () => {
  it.live("unsets a single secret given explicitly (with --yes)", () => {
    const { layer, out, api } = setup({ yes: true });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] });
      // No GET call: names came from args.
      expect(api.requests.filter((r) => r.method === "GET")).toHaveLength(0);
      const deletes = api.requests.filter((r) => r.method === "DELETE");
      expect(deletes).toHaveLength(1);
      expect(parseDeleteBody(deletes[0]!.body)).toEqual(["FOO"]);
      expect(out.stdoutText).toBe("Finished supabase secrets unset.\n");
    }).pipe(Effect.provide(layer));
  });

  it.live("unsets multiple secrets given explicitly", () => {
    const { layer, api } = setup({ yes: true });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({
        projectRef: Option.none(),
        names: ["FOO", "BAR"],
      });
      const deletes = api.requests.filter((r) => r.method === "DELETE");
      expect(parseDeleteBody(deletes[0]!.body)).toEqual(["FOO", "BAR"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("empty-args path lists secrets and DELETEs the non-SUPABASE_ subset", () => {
    const { layer, api } = setup({
      yes: true,
      list: [
        { name: "FOO", value: "d1" },
        { name: "SUPABASE_AUTH_TOKEN", value: "d2" },
        { name: "BAR", value: "d3" },
      ],
    });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({ projectRef: Option.none(), names: [] });
      const gets = api.requests.filter((r) => r.method === "GET");
      const deletes = api.requests.filter((r) => r.method === "DELETE");
      expect(gets).toHaveLength(1);
      expect(parseDeleteBody(deletes[0]!.body)).toEqual(["FOO", "BAR"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("empty-args path with all-SUPABASE_ secrets writes stderr no-op and exits 0", () => {
    const { layer, out, api } = setup({
      yes: true,
      list: [{ name: "SUPABASE_ONLY", value: "d" }],
    });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({ projectRef: Option.none(), names: [] });
      expect(out.stderrText).toContain("You have not set any function secrets, nothing to do.");
      expect(api.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("empty-args path with empty server list writes the stderr no-op and exits 0", () => {
    const { layer, out, api } = setup({ yes: true, list: [] });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({ projectRef: Option.none(), names: [] });
      expect(out.stderrText).toContain("You have not set any function secrets, nothing to do.");
      expect(api.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("--yes bypasses the prompt and echoes [Y/n] y to stderr", () => {
    const { layer, out } = setup({ yes: true });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] });
      expect(out.stderrText).toContain("Do you want to unset these function secrets?");
      expect(out.stderrText).toContain(" • FOO");
      expect(out.stderrText).toContain("[Y/n] y");
    }).pipe(Effect.provide(layer));
  });

  it.live("non-TTY with empty stdin prints the label and takes the Yes default (Go parity)", () => {
    const { layer, out, api } = setup({ yes: false, stdinIsTty: false });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] });
      // `PromptText` prints the label to stderr, the 100ms non-TTY read scans
      // nothing, and the empty input is echoed back before the true default wins
      // (`console.go:64-102`).
      expect(out.stderrText).toContain(
        "Do you want to unset these function secrets?\n • FOO\n\n [Y/n] \n",
      );
      expect(api.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("non-TTY with piped `n` declines like Go (echoed answer, no DELETE)", () => {
    const { layer, out, api } = setup({ yes: false, stdinIsTty: false, stdinInput: "n\n" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySecretsUnsetCancelledError");
      }
      // The piped answer is echoed to stderr, matching non-TTY `PromptText`.
      expect(out.stderrText).toContain("[Y/n] n\n");
      expect(api.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("non-TTY with piped `y` confirms like Go", () => {
    const { layer, out, api } = setup({ yes: false, stdinIsTty: false, stdinInput: "y\n" });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] });
      expect(out.stderrText).toContain("[Y/n] y\n");
      expect(api.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("SUPABASE_YES=1 in the environment auto-confirms with the [Y/n] y echo", () => {
    const prev = process.env["SUPABASE_YES"];
    process.env["SUPABASE_YES"] = "1";
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] });
      // Same bytes as the `viper.GetBool("YES")` branch (`console.go:70-72`).
      expect(out.stderrText).toContain(
        "Do you want to unset these function secrets?\n • FOO\n\n [Y/n] y\n",
      );
      expect(api.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (prev === undefined) delete process.env["SUPABASE_YES"];
          else process.env["SUPABASE_YES"] = prev;
        }),
      ),
      Effect.provide(layer),
    );
  });

  it.live("TTY without --yes prompts via output.promptConfirm and proceeds on accept", () => {
    const { layer, api } = setup({ yes: false, stdinIsTty: true, confirm: true });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] });
      expect(api.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("TTY without --yes fails with LegacySecretsUnsetCancelledError on decline", () => {
    const { layer, api } = setup({ yes: false, stdinIsTty: true, confirm: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySecretsUnsetCancelledError");
      }
      expect(api.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySecretsListNetworkError on GET failure (empty-args path)", () => {
    const { layer } = setup({ yes: true, listNetwork: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySecretsUnset({ projectRef: Option.none(), names: [] }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySecretsListNetworkError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySecretsListUnexpectedStatusError on GET 503 (empty-args path)", () => {
    const { layer } = setup({ yes: true, listStatus: 503 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacySecretsUnset({ projectRef: Option.none(), names: [] }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacySecretsListUnexpectedStatusError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySecretsUnsetNetworkError on DELETE transport failure", () => {
    const { layer } = setup({ yes: true, deleteNetwork: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacySecretsUnsetNetworkError");
        expect(errJson).toContain("failed to delete secrets");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySecretsUnsetUnexpectedStatusError on DELETE 500", () => {
    const { layer } = setup({ yes: true, deleteStatus: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacySecretsUnsetUnexpectedStatusError");
        expect(errJson).toContain("Unexpected error unsetting project secrets");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event with { project_ref, count } for --output-format=json", () => {
    const { layer, out } = setup({ yes: true, format: "json" });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({
        projectRef: Option.none(),
        names: ["FOO", "BAR"],
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toEqual({ project_ref: LEGACY_VALID_REF, count: 2 });
    }).pipe(Effect.provide(layer));
  });

  it.live("--output-format=json without --yes takes the Yes default silently", () => {
    // TS-only machine mode has no Go equivalent; `legacyPromptYesNo` documents
    // that json/stream-json never prompts and takes the call site's default —
    // for unset that is Yes, mirroring the non-TTY default-through behavior
    // for scripts. Deliberate (CLI-1974 review); pass --yes explicitly in
    // automation for clarity.
    const { layer, out, api } = setup({ yes: false, format: "json" });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(api.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event for --output-format=stream-json", () => {
    const { layer, out } = setup({ yes: true, format: "stream-json" });
    return Effect.gen(function* () {
      yield* legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "text mode prints `Finished supabase secrets unset.\\n` regardless of --output value",
    () => {
      const { layer, out } = setup({ yes: true, goOutput: "json" });
      return Effect.gen(function* () {
        yield* legacySecretsUnset({ projectRef: Option.none(), names: ["FOO"] });
        expect(out.stdoutText).toBe("Finished supabase secrets unset.\n");
      }).pipe(Effect.provide(layer));
    },
  );
});
