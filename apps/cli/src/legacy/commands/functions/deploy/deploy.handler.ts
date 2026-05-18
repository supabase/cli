import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";

interface LegacyFunctionsDeployFlags {
  readonly functionNames: ReadonlyArray<string>;
  readonly projectRef: Option.Option<string>;
  readonly noVerifyJwt: boolean;
  readonly useApi: boolean;
  readonly jobs: Option.Option<number>;
  readonly importMap: Option.Option<string>;
  readonly prune: boolean;
}

export const legacyFunctionsDeploy = Effect.fn("legacy.functions.deploy")(function* (
  flags: LegacyFunctionsDeployFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["functions", "deploy"];
  args.push(...flags.functionNames);
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  if (flags.noVerifyJwt) args.push("--no-verify-jwt");
  if (flags.useApi) args.push("--use-api");
  if (Option.isSome(flags.jobs)) args.push("--jobs", String(flags.jobs.value));
  if (Option.isSome(flags.importMap)) args.push("--import-map", flags.importMap.value);
  if (flags.prune) args.push("--prune");
  yield* proxy.exec(args);
});
