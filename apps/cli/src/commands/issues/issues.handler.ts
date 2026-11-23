import { Effect, Option } from "effect";
import { resolveTarget } from "../../command-internal/target/resolve-target.ts";
import { DnsResolverFlag, OutputFlag } from "../../command-internal/global-flags.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import { renderIssuesText } from "./issues.text.ts";
import { Output } from "../../shared/output/output.service.ts";
import { ProcessControl } from "../../shared/runtime/process-control.service.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import { LinkedProjectCache } from "../../telemetry/linked-project-cache.service.ts";
import { collectLocalAdvisorLints } from "../../command-internal/advisors/advisors.local.ts";
import type { AdvisorLint } from "../../command-internal/advisors/advisors.format.ts";
import { collectRemoteIssues } from "./issues.remote.ts";
import {
  groupIssues,
  issueCheckCoverage,
  severityAtLeast,
  type CheckCoverage,
  type IssueCategory,
} from "./issues.format.ts";
import { unsupportedOutputFlagMessage } from "../../command-internal/output-formats.ts";
import { IssuesOutputFlagUnsupportedError, IssuesHealthUnsupportedError } from "./issues.errors.ts";
import type { IssuesFlags } from "./issues.command.ts";

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
    const remote =
      target.kind === "linked" ? yield* collectRemoteIssues(target.ref, categories) : undefined;
    const local =
      target.kind !== "linked" && type !== "health"
        ? yield* collectLocalAdvisorLints(target, dns)
        : [];
    if (remote !== undefined) {
      lints.push(...remote.lints);
      checks.push(...remote.checks);
      return;
    }
    for (const category of categories) {
      if (category === "health" && target.kind !== "linked") {
        checks.push({
          type: "health",
          status: "unavailable",
          reason: "Health checks require a remote project.",
        });
        continue;
      }
      const found = local.filter((lint) => lint.categories?.includes(category.toUpperCase()));
      checks.push(issueCheckCoverage(category, found));
      lints.push(...found.map((lint) => ({ ...lint, categories: [category.toUpperCase()] })));
    }
  });
  const task = yield* output.task("Checking project issues");
  const checked = collect.pipe(
    Effect.tap(() =>
      target.kind === "linked" && checks.some((check) => check.status === "unavailable")
        ? task.fail()
        : task.succeed(),
    ),
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
