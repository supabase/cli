import { describe, expect, it } from "@effect/vitest";
import { Console, Effect, Layer, Option } from "effect";
import { CliOutput, Command } from "effect/cli";

import { emptyEnv, fakeConsole, mockOutput } from "../../../tests/helpers/mocks.ts";
import { projectsCommand } from "../../commands/projects/projects.command.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { jsonCliOutputFormatter } from "../../shared/output/json-formatter.ts";
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

const layerFor = (
  args: ReadonlyArray<string>,
  console: Console.Console,
  formatter: CliOutput.Formatter,
) =>
  Layer.mergeAll(
    emptyEnv(),
    CliOutput.layer(formatter),
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

const helpFor = (
  args: ReadonlyArray<string>,
  formatter: CliOutput.Formatter = textCliOutputFormatter(),
) =>
  Effect.gen(function* () {
    const { console, calls } = fakeConsole();
    yield* Effect.scoped(
      Command.runWith(projectsCommand, { version: "0.0.0-test" })(args).pipe(
        Effect.provide(layerFor(args, console, formatter)),
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
          "  Scoped access token:",
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

  it.effect("carries the same section as data in JSON help, without the raw declaration", () =>
    Effect.gen(function* () {
      const text = yield* helpFor(["api-keys", "--help"]);
      const printed = yield* helpFor(["api-keys", "--help"], jsonCliOutputFormatter());
      const json = JSON.parse(printed.replace(/^log:/, ""));

      expect(json.permissions).toEqual({
        status: "mapped",
        schemes: [
          {
            scheme: "fga",
            title: "Scoped access token",
            groups: [
              {
                heading: "Required with --reveal",
                need: "required",
                when: [{ all: [{ flag: "reveal", values: ["true"] }] }],
                rows: [{ anyOf: [["api_gateway_keys_read", "api_gateway_keys_secret_read"]] }],
              },
              {
                heading: "Required without --reveal",
                need: "required",
                when: [{ all: [{ flag: "reveal", values: ["false"] }] }],
                rows: [{ anyOf: [["api_gateway_keys_read"]] }],
              },
              {
                heading: "May be required (without --project-ref)",
                need: "maybe",
                when: [{ all: [{ flag: "project-ref", values: ["unset", "empty"] }] }],
                rows: [{ anyOf: [["projects_read"]] }],
              },
              {
                heading: "Optional (command still runs without these)",
                need: "optional",
                rows: [{ anyOf: [["project_admin_read"]] }],
              },
            ],
          },
        ],
      });
      expect(JSON.stringify(json.doc)).not.toContain("supabase/Command");

      const block = text.slice(text.indexOf("PERMISSIONS"));
      for (const scheme of json.permissions.schemes) {
        for (const group of scheme.groups) {
          expect(block).toContain(`${group.heading}:`);
          for (const row of group.rows) {
            const shown: ReadonlyArray<string> =
              "anyOf" in row
                ? row.anyOf.map((alternative: ReadonlyArray<string>) => alternative.join(" + "))
                : "cases" in row
                  ? row.cases.map(
                      (item: { for: string; allOf: ReadonlyArray<string> }) =>
                        `${item.allOf.join(" + ")} for ${item.for}`,
                    )
                  : [row.note];
            for (const text of shown) expect(block).toContain(text);
          }
        }
      }
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
