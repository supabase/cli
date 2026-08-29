import type { ServiceName, StackVersionPlan, VersionRuntime } from "@supabase/stack/effect";
import {
  defaultVersionsForRuntime,
  normalizeServiceVersion,
  planStackVersions,
  SERVICE_NAMES,
} from "@supabase/stack/effect";
import { Data, Effect, Option } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
import { CliProjectLocalServiceVersions } from "./cli-project-local-service-versions.service.ts";
import { ProjectLinkState } from "./project-link-state.service.ts";

export type ResolvedServiceVersionContext = StackVersionPlan;

export class InvalidServiceVersionOverrideError extends Data.TaggedError(
  "InvalidServiceVersionOverrideError",
)<{
  readonly detail: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

function isServiceName(value: string): value is ServiceName {
  return (SERVICE_NAMES as ReadonlyArray<string>).includes(value);
}

export const parseServiceVersionOverrides = Effect.fnUntraced(function* (
  rawOverrides: ReadonlyArray<string>,
  runtime: VersionRuntime = "native",
) {
  const overrides: Partial<Record<ServiceName, string>> = {};

  for (const rawOverride of rawOverrides) {
    const separatorIndex = rawOverride.indexOf("=");
    const rawService =
      separatorIndex === -1 ? rawOverride.trim() : rawOverride.slice(0, separatorIndex).trim();
    const rawVersion = separatorIndex === -1 ? "" : rawOverride.slice(separatorIndex + 1).trim();

    if (!isServiceName(rawService)) {
      return yield* Effect.fail(
        new InvalidServiceVersionOverrideError({
          detail: `Invalid service version override '${rawOverride}'. Unknown service '${rawService}'.`,
          suggestion: `Use one of: ${SERVICE_NAMES.join(", ")}.`,
        }),
      );
    }

    if (rawVersion.length === 0) {
      return yield* Effect.fail(
        new InvalidServiceVersionOverrideError({
          detail: `Invalid service version override '${rawOverride}'. Expected format service=version.`,
          suggestion: `Pass --service-version ${rawService}=${defaultVersionsForRuntime(runtime)[rawService]}.`,
        }),
      );
    }

    overrides[rawService] = normalizeServiceVersion(rawService, rawVersion, runtime);
  }

  return overrides;
});

export const resolveServiceVersionContext = Effect.fnUntraced(function* (
  rawOverrides: ReadonlyArray<string>,
  pinnedBaselineOverride?: Partial<Record<ServiceName, string | undefined>>,
  runtime?: VersionRuntime,
) {
  const projectLinkState = yield* ProjectLinkState;
  const cliProjectLocalServiceVersions = yield* CliProjectLocalServiceVersions;

  const flagOverrides = yield* parseServiceVersionOverrides(rawOverrides, runtime);
  const localState = yield* cliProjectLocalServiceVersions.load;
  const linkedState = yield* projectLinkState.load;

  return planStackVersions({
    runtime,
    candidateBaseline: Option.match(linkedState, {
      onNone: () => undefined,
      onSome: (state) => state.versions,
    }),
    pinnedBaseline: pinnedBaselineOverride,
    localOverrides: Option.match(localState, {
      onNone: () => undefined,
      onSome: (state) => state.versions,
    }),
    flagOverrides,
  }) satisfies ResolvedServiceVersionContext;
});
