import { describe, expect, it } from "@effect/vitest";
import { Console, Effect, Layer, Option } from "effect";
import { CliOutput, Command } from "effect/cli";

import { emptyEnv, fakeConsole, mockOutput } from "../../../tests/helpers/mocks.ts";
import { projectsCommand } from "../../commands/projects/projects.command.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { textCliOutputFormatter } from "../../shared/output/text-formatter.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  ExperimentalFlag,
  OutputFlag,
  ProfileFlag,
  WorkdirFlag,
  YesFlag,
} from "../global-flags.ts";

const layerFor = (args: ReadonlyArray<string>, console: Console.Console) =>
  Layer.mergeAll(
    emptyEnv(),
    CliOutput.layer(textCliOutputFormatter()),
    Layer.succeed(CliArgs, { args }),
    Layer.succeed(Console.Console, console),
    Layer.succeed(DebugFlag, false),
    Layer.succeed(OutputFlag, Option.none()),
    Layer.succeed(ExperimentalFlag, false),
    Layer.succeed(ProfileFlag, "supabase"),
    Layer.succeed(WorkdirFlag, Option.none()),
    Layer.succeed(YesFlag, false),
    Layer.succeed(DnsResolverFlag, "native"),
    mockOutput({ format: "text" }).layer,
  );

const helpFor = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { console, calls } = fakeConsole();
    yield* Effect.scoped(
      Command.runWith(projectsCommand, { version: "0.0.0-test" })(args).pipe(
        Effect.provide(layerFor(args, console)),
      ),
    );
    return calls.join("\n");
  });

describe("token permissions in command help", () => {
  it.effect("shows the permissions a leaf command needs, with the --reveal case separate", () =>
    Effect.gen(function* () {
      const text = yield* helpFor(["api-keys", "--help"]);

      expect(text.slice(text.indexOf("PERMISSIONS"))).toContain(
        [
          "PERMISSIONS",
          "  Personal access token (FGA):",
          "    Required with --reveal:",
          "      api_gateway_keys_read + api_gateway_keys_secret_read",
          "    Required without --reveal:",
          "      api_gateway_keys_read",
          "    May be required (without --project-ref):",
          "      projects_read",
          "    Optional (command still runs without these):",
          "      project_admin_read",
        ].join("\n"),
      );
    }),
  );

  it.effect("shows no permissions section on a command group", () =>
    Effect.gen(function* () {
      const text = yield* helpFor(["--help"]);

      expect(text).toContain("api-keys");
      expect(text).not.toContain("PERMISSIONS");
    }),
  );
});
