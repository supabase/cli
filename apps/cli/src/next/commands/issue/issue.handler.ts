import { Effect } from "effect";
import { Browser } from "../../../shared/runtime/browser.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { TelemetryRuntime } from "../../../shared/telemetry/runtime.service.ts";
import {
  buildIssueUrl,
  inferIssueInstallMethod,
  issueTemplateContract,
  readIssueFlagValue,
  searchedExistingIssuesValue,
} from "../../../shared/issue/issue-url.ts";
import type { BugIssueFlags, DocsIssueFlags, FeatureIssueFlags } from "./issue.command.ts";

const openIssueUrl = Effect.fnUntraced(function* (url: string, noBrowser: boolean) {
  const output = yield* Output;
  yield* output.raw(`${url}\n`);
  if (!noBrowser) {
    const browser = yield* Browser;
    yield* browser.open(url);
    yield* output.success("Opened GitHub issue form.", { url });
  } else {
    yield* output.info("GitHub issue form URL:");
  }
});

export const openBugIssue = Effect.fn("issue.bug")(function* (flags: BugIssueFlags) {
  const runtimeInfo = yield* RuntimeInfo;
  const telemetryRuntime = yield* TelemetryRuntime;

  const url = buildIssueUrl({
    template: issueTemplateContract.bug.template,
    fields: {
      "affected-area": readIssueFlagValue(flags.area),
      "cli-version": telemetryRuntime.cliVersion,
      os: `${runtimeInfo.platform} ${runtimeInfo.arch}`,
      "install-method": inferIssueInstallMethod(runtimeInfo),
      command: readIssueFlagValue(flags.command),
      "actual-output": readIssueFlagValue(flags.actualOutput),
      "expected-behavior": readIssueFlagValue(flags.expectedBehavior),
      reproduce: readIssueFlagValue(flags.reproduce),
      "ticket-id": readIssueFlagValue(flags.crashReportId),
      "docker-services": readIssueFlagValue(flags.dockerServices),
      "additional-context": readIssueFlagValue(flags.additionalContext),
    },
  });

  yield* openIssueUrl(url, flags.noBrowser);
});

export const openFeatureIssue = Effect.fn("issue.feature")(function* (flags: FeatureIssueFlags) {
  const url = buildIssueUrl({
    template: issueTemplateContract.feature.template,
    fields: {
      "existing-issues": flags.existingIssues ? searchedExistingIssuesValue : undefined,
      "affected-area": readIssueFlagValue(flags.area),
      problem: readIssueFlagValue(flags.problem),
      "proposed-solution": readIssueFlagValue(flags.proposedSolution),
      alternatives: readIssueFlagValue(flags.alternatives),
      "additional-context": readIssueFlagValue(flags.additionalContext),
    },
  });

  yield* openIssueUrl(url, flags.noBrowser);
});

export const openDocsIssue = Effect.fn("issue.docs")(function* (flags: DocsIssueFlags) {
  const url = buildIssueUrl({
    template: issueTemplateContract.docs.template,
    fields: {
      link: readIssueFlagValue(flags.link),
      "issue-type": readIssueFlagValue(flags.issueType),
      problem: readIssueFlagValue(flags.problem),
      improvement: readIssueFlagValue(flags.improvement),
      "additional-context": readIssueFlagValue(flags.additionalContext),
    },
  });

  yield* openIssueUrl(url, flags.noBrowser);
});
