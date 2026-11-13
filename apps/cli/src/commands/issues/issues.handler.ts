import { Effect, Option } from "effect";
import { resolveTarget } from "../../command-internal/target/resolve-target.ts";
import { DnsResolverFlag, OutputFlag } from "../../command-internal/global-flags.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import { renderIssuesText } from "./issues.text.ts";
import { Output } from "../../shared/output/output.service.ts";
import { ProcessControl } from "../../shared/runtime/process-control.service.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import { LinkedProjectCache } from "../../telemetry/linked-project-cache.service.ts";
import { CommandPlatformApiFactory } from "../../auth/command-platform-api-factory.service.ts";
import { collectLocalAdvisorLints } from "../../command-internal/advisors/advisors.local.ts";
import {
  fetchPerformanceAdvisors,
  fetchSecurityAdvisors,
} from "../../command-internal/advisors/advisors.linked.ts";
import {
  apiLintsToAdvisorLints,
  type AdvisorLint,
} from "../../command-internal/advisors/advisors.format.ts";
import {
  groupIssues,
  isUnavailableCheck,
  unescapeIssueText,
  severityAtLeast,
  type CheckCoverage,
  type IssueCategory,
} from "./issues.format.ts";
import { unsupportedOutputFlagMessage } from "../../command-internal/output-formats.ts";
import { IssuesOutputFlagUnsupportedError, IssuesHealthUnsupportedError } from "./issues.errors.ts";
import type { IssuesFlags } from "./issues.command.ts";

const healthChecks = [
  "log_data_api_error_rate_high",
  "log_auth_error_rate_high",
  "log_storage_error_rate_high",
  "log_edge_function_error_rate_high",
] as const;
const fetchHealth = Effect.fn("issues.fetchHealth")(function* (ref: string) {
  const api = yield* (yield* CommandPlatformApiFactory).make;
  const result = yield* api.v2.runProjectAdvisors({
    ref,
    data: {
      type: "project_advisors",
      attributes: { lints: healthChecks.map((name) => ({ name })) },
    },
  });
  return apiLintsToAdvisorLints(result.data.attributes.lints);
});
const fetchRemoteIssues = Effect.fn("issues.fetchRemote")(function* (
  ref: string,
  category: IssueCategory,
) {
  if (category === "health") return yield* fetchHealth(ref);
  if (category === "security") return yield* fetchSecurityAdvisors(ref);
  return yield* fetchPerformanceAdvisors(ref);
});
const runIssues = Effect.fn("issues.run")(function* (flags: IssuesFlags) {
  if (Option.isSome(yield* OutputFlag))
    return yield* new IssuesOutputFlagUnsupportedError({
      message: unsupportedOutputFlagMessage("issues"),
    });
  const target = yield* resolveTarget(flags);
  const dns = yield* DnsResolverFlag;
  const output = yield* Output;
  const process = yield* ProcessControl;
  const type = Option.getOrElse(flags.type, () => "all" as const);
  const minimum = Option.getOrElse(flags.severity, () => "info" as const);
  const failOn = Option.getOrElse(flags.failOn, () => "none" as const);
  if (type === "health" && target.kind !== "linked") {
    return yield* new IssuesHealthUnsupportedError({
      message:
        "Health checks require a remote project. Use supabase issues --remote --type health.",
    });
  }
  const categories: ReadonlyArray<IssueCategory> =
    type === "all" ? ["security", "performance", "health"] : [type];
  const lints: AdvisorLint[] = [];
  const checks: CheckCoverage[] = [];
  const collect = Effect.gen(function* () {
    const local =
      target.kind !== "linked" && type !== "health"
        ? yield* collectLocalAdvisorLints(target, dns)
        : [];
    for (const category of categories) {
      if (category === "health" && target.kind !== "linked") {
        checks.push({
          type: "health",
          status: "unavailable",
          reason: "Health checks require a remote project.",
        });
        continue;
      }
      const found =
        target.kind === "linked"
          ? yield* fetchRemoteIssues(target.ref, category)
          : local.filter((lint) => lint.categories?.includes(category.toUpperCase()));
      const unavailable = found.filter(isUnavailableCheck);
      checks.push(
        unavailable.length === 0
          ? { type: category, status: "complete" }
          : {
              type: category,
              status: "unavailable",
              reason: unavailable
                .map((lint) => `${lint.name}: ${unescapeIssueText(lint.detail)}`)
                .join("; "),
            },
      );
      lints.push(...found.map((lint) => ({ ...lint, categories: [category.toUpperCase()] })));
    }
  });
  const task = yield* output.task("Checking project issues");
  const checked = collect.pipe(
    Effect.tap(() => task.succeed()),
    Effect.tapError(() => task.fail()),
  );
  if (target.kind === "linked")
    yield* checked.pipe(Effect.ensuring((yield* LinkedProjectCache).cache(target.ref)));
  else yield* checked;
  const issues = yield* groupIssues(lints, minimum);
  yield* Effect.annotateCurrentSpan("issues.count", issues.length);
  if (output.format === "text") {
    const tty = yield* Effect.serviceOption(Tty);
    const width = Option.isSome(tty) ? (tty.value.stdoutColumns ?? 80) : 80;
    yield* output.raw(renderIssuesText(issues, checks, minimum, width));
  } else yield* output.success("issues", { issues, checks });
  const unavailableRemote =
    target.kind === "linked" && checks.some((check) => check.status === "unavailable");
  const thresholdReached =
    failOn !== "none" && issues.some((issue) => severityAtLeast(issue.severity, failOn));
  if (unavailableRemote || thresholdReached) yield* process.setExitCode(1);
});
export const issues = Effect.fn("issues")(function* (flags: IssuesFlags) {
  yield* runIssues(flags).pipe(Effect.ensuring((yield* TelemetryState).flush));
});
