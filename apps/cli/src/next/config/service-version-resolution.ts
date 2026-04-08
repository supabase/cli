import type { ServiceName, StackVersionPlan, VersionManifest } from "@supabase/stack/effect";
import {
  DEFAULT_VERSIONS,
  normalizeServiceVersion,
  planStackVersions,
  SERVICE_NAMES,
} from "@supabase/stack/effect";
import { Data, Effect, Option } from "effect";
import { ProjectLocalServiceVersions } from "./project-local-service-versions.service.ts";
import { ProjectLinkState } from "./project-link-state.service.ts";

export type ResolvedServiceVersionContext = StackVersionPlan;

class InvalidServiceVersionOverrideError extends Data.TaggedError(
  "InvalidServiceVersionOverrideError",
)<{
  readonly detail: string;
  readonly suggestion: string;
}> {}

function isServiceName(value: string): value is ServiceName {
  return (SERVICE_NAMES as ReadonlyArray<string>).includes(value);
}

export const parseServiceVersionOverrides = Effect.fnUntraced(function* (
  rawOverrides: ReadonlyArray<string>,
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
          suggestion: `Pass --service-version ${rawService}=${DEFAULT_VERSIONS[rawService]}.`,
        }),
      );
    }

    overrides[rawService] = normalizeServiceVersion(rawService, rawVersion);
  }

  return overrides;
});

export const resolveServiceVersionContext = Effect.fnUntraced(function* (
  rawOverrides: ReadonlyArray<string>,
  pinnedBaselineOverride?: VersionManifest,
) {
  const projectLinkState = yield* ProjectLinkState;
  const projectLocalServiceVersions = yield* ProjectLocalServiceVersions;

  const flagOverrides = yield* parseServiceVersionOverrides(rawOverrides);
  const localState = yield* projectLocalServiceVersions.load;
  const linkedState = yield* projectLinkState.load;

  return planStackVersions({
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
