import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";
import { withTargetPolicy } from "../../command-internal/target/target-policy.ts";
import { browserLayer } from "../../shared/runtime/browser.layer.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { issueBug, issueDocs, issueFeature } from "./issue.handler.ts";
import { withPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";
import { cliFlag, makeCommand } from "../../shared/cli/cli-params.ts";

const issueNoBrowserFlag = cliFlag("no-browser", Flag.Boolean, {
  description: "Print the form URL without opening a browser.",
  default: false,
});

const issueOptionalTextFlag = (name: string, description: string) =>
  cliFlag(name, Flag.String, { description: description, optional: true });

const issueCommonContextFlag = issueOptionalTextFlag(
  "additional-context",
  "Extra context to prefill on the form.",
);

const issueBugConfig = {
  area: issueOptionalTextFlag("area", "Affected CLI area."),
  command: issueOptionalTextFlag("command", "Command that failed."),
  actualOutput: issueOptionalTextFlag("actual-output", "Actual output or error text."),
  expectedBehavior: issueOptionalTextFlag("expected-behavior", "What you expected to happen."),
  reproduce: issueOptionalTextFlag("reproduce", "Steps to reproduce the problem."),
  crashReportId: issueOptionalTextFlag(
    "crash-report-id",
    "Crash report or support ticket ID, if you have one.",
  ),
  dockerServices: issueOptionalTextFlag(
    "docker-services",
    "Relevant Docker service status or logs.",
  ),
  additionalContext: issueCommonContextFlag,
  noBrowser: issueNoBrowserFlag,
} as const;

const issueFeatureConfig = {
  existingIssues: cliFlag("existing-issues", Flag.Boolean, {
    description: "Prefill the checklist item for having searched existing issues.",
    default: false,
  }),
  area: issueOptionalTextFlag("area", "Affected CLI area."),
  problem: issueOptionalTextFlag("problem", "Problem the feature should solve."),
  proposedSolution: issueOptionalTextFlag("proposed-solution", "Solution you would like to see."),
  alternatives: issueOptionalTextFlag("alternatives", "Alternatives you considered."),
  additionalContext: issueCommonContextFlag,
  noBrowser: issueNoBrowserFlag,
} as const;

const issueDocsConfig = {
  link: issueOptionalTextFlag("link", "Relevant documentation link."),
  issueType: issueOptionalTextFlag("issue-type", "Documentation issue type."),
  problem: issueOptionalTextFlag("problem", "What is confusing, missing, or incorrect."),
  improvement: issueOptionalTextFlag("improvement", "Suggested improvement to the documentation."),
  additionalContext: issueCommonContextFlag,
  noBrowser: issueNoBrowserFlag,
} as const;

export type IssueBugFlags = CliCommand.Command.Config.Infer<typeof issueBugConfig>;
export type IssueFeatureFlags = CliCommand.Command.Config.Infer<typeof issueFeatureConfig>;
export type IssueDocsFlags = CliCommand.Command.Config.Infer<typeof issueDocsConfig>;

const issueBugCommand = makeCommand("bug", issueBugConfig).pipe(
  Command.withDescription("Report a problem with the CLI. The form opens with your local CLI details already filled in."),
  Command.withShortDescription("Open a bug report"),
  Command.withExamples([
    {
      command:
        'supabase issue bug --command "supabase start" --actual-output "database failed to start"',
      description: "Open a prefilled bug report for a failing command",
    },
    {
      command: 'supabase issue bug --crash-report-id "abc123" --no-browser',
      description: "Print a prefilled issue URL with a crash report ID",
    },
  ]),
  withPermissions({
    operations: [],
    noApiEffectFlags: [
      "area",
      "command",
      "actual-output",
      "expected-behavior",
      "reproduce",
      "crash-report-id",
      "docker-services",
      "additional-context",
      "no-browser",
    ],
  }),
  Command.withHandler((flags) =>
    issueBug(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["issue", "bug"])),
  Command.provide(browserLayer),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);

const issueFeatureCommand = makeCommand("feature", issueFeatureConfig).pipe(
  Command.withDescription("Propose a new CLI feature or an improvement to an existing one."),
  Command.withShortDescription("Open a feature request"),
  Command.withExamples([
    {
      command:
        'supabase issue feature --existing-issues --problem "I need to rotate local secrets" --proposed-solution "Add a secrets rotate command"',
      description: "Open a prefilled feature request",
    },
  ]),
  withPermissions({
    operations: [],
    noApiEffectFlags: [
      "existing-issues",
      "area",
      "problem",
      "proposed-solution",
      "alternatives",
      "additional-context",
      "no-browser",
    ],
  }),
  Command.withHandler((flags) =>
    issueFeature(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["issue", "feature"])),
  Command.provide(browserLayer),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);

const issueDocsCommand = makeCommand("docs", issueDocsConfig).pipe(
  Command.withDescription("Report documentation that is confusing, missing, or incorrect."),
  Command.withShortDescription("Open a documentation issue"),
  Command.withExamples([
    {
      command:
        'supabase issue docs --link "https://supabase.com/docs/guides/cli" --problem "The flag description is outdated"',
      description: "Open a prefilled documentation issue",
    },
  ]),
  withPermissions({
    operations: [],
    noApiEffectFlags: [
      "link",
      "issue-type",
      "problem",
      "improvement",
      "additional-context",
      "no-browser",
    ],
  }),
  Command.withHandler((flags) =>
    issueDocs(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["issue", "docs"])),
  Command.provide(browserLayer),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);

export const issueCommand = Command.make("issue").pipe(
  Command.withDescription(
    "Open a prefilled Supabase CLI issue form on GitHub to report a bug, request a feature, or flag a documentation problem. " +
      "Use the flags to prefill form fields, or pass --no-browser to print the URL instead.",
  ),
  Command.withShortDescription("Open a GitHub issue form"),
  Command.withSubcommands([issueBugCommand, issueFeatureCommand, issueDocsCommand]),
);
