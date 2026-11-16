import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { withPermissions } from "../command-permissions/command-permissions.annotation.ts";
import { compose } from "../command-permissions/model.ts";
import { managementApiRuntimeLayer } from "../management-api-runtime.layer.ts";
import { branchResolution } from "../target/branch-resolution.ts";
import { projectTargetFlags } from "../target/target-flags.ts";
import { withTargetPolicy } from "../target/target-policy.ts";
import { projectRefPicker } from "../../config/project-ref.layer.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { linkedProjectCache } from "../../telemetry/linked-project-cache.layer.ts";
import type { ApiCommandData, ApiField } from "./model.ts";
import { executeApiCommand, validateApiCommand, withApiCommandErrors } from "./runtime.ts";

const scalarFlag = (field: ApiField): Flag.Flag<unknown> => {
  switch (field.type) {
    case "boolean":
      return Flag.Boolean(field.name);
    case "number":
      return Flag.Finite(field.name);
    case "integer":
      return Flag.Int(field.name);
    case "string":
      return field.choices ? Flag.Literals(field.name, field.choices) : Flag.String(field.name);
  }
};

const apiCommandConfig = (data: ApiCommandData) => {
  const input: Record<string, Flag.Flag<unknown>> = {};
  for (const field of data.fields) {
    const base = scalarFlag(field).pipe(Flag.withDescription(field.description));
    input[field.name] = field.repeatable
      ? base.pipe(
          Flag.atLeast(field.required ? 1 : 0),
          Flag.map((values) => (values.length ? values : undefined)),
        )
      : field.required
        ? base
        : base.pipe(Flag.optional, Flag.map(Option.getOrUndefined));
  }
  return {
    ...projectTargetFlags(),
    input,
    wait: Flag.Boolean("wait").pipe(
      Flag.withDescription("Wait for the API to report completion."),
      Flag.withDefault(false),
    ),
    timeout: Flag.String("timeout").pipe(
      Flag.withDescription("Maximum wait duration, for example 15m."),
      Flag.withDefault("15m"),
    ),
  };
};

export function makeApiCommand(data: ApiCommandData) {
  const config = apiCommandConfig(data);
  return Command.make(data.method, config).pipe(
    Command.withDescription(
      `${data.description}${data.experimental ? " Requires --experimental." : ""}`,
    ),
    Command.withShortDescription(`${data.summary}${data.experimental ? " (experimental)" : ""}`),
    withPermissions(
      compose(
        {
          operations: [
            { operationId: data.operationId, kind: "required" },
            ...(data.wait
              ? [
                  {
                    operationId: data.wait.read,
                    kind: "required" as const,
                    when: [{ flag: "wait", is: true }],
                  },
                ]
              : []),
          ],
          noApiEffectFlags: [...data.fields.map((field) => field.name), "timeout"],
        },
        branchResolution,
        projectRefPicker,
        linkedProjectCache,
      ),
    ),
    Command.withHandler((flags) =>
      Effect.gen(function* () {
        const timeout = yield* validateApiCommand(data, flags);
        yield* executeApiCommand(data, flags, timeout).pipe(
          withCommandTelemetry({
            flags: { ...flags.input, wait: flags.wait, timeout: flags.timeout },
            outputFormats: ["json", "yaml"],
          }),
          Effect.provide(managementApiRuntimeLayer([...data.group.split("."), data.method])),
        );
      }).pipe(withApiCommandErrors),
    ),
    withTargetPolicy({ group: "hosted", consent: "no" }),
  );
}
