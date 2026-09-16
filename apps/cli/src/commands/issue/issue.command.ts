import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { browserLayer } from "../../shared/runtime/browser.layer.ts";
import { commandRuntimeLayer } from "../../shared/runtime/command-runtime.layer.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { issueBug, issueDocs, issueFeature } from "./issue.handler.ts";

const issueNoBrowserFlag = Flag.boolean("no-browser").pipe(
  Flag.withDescription("Print the issue form URL without opening a browser."),
  Flag.withDefault(false),
);

const issueOptionalTextFlag = (name: string, description: string) =>
  Flag.string(name).pipe(Flag.withDescription(description), Flag.optional);

const issueCommonContextFlag = issueOptionalTextFlag(
  "additional-context",
  "Extra context to prefill on the issue form.",
);

const issueBugConfig = {
  area: issueOptionalTextFlag("area", "Affected CLI area."),
  command: issueOptionalTextFlag("command", "Command that failed."),
  actualOutput: issueOptionalTextFlag("actual-output", "Actual output or error text."),
  expectedBehavior: issueOptionalTextFlag("expected-behavior", "Expected behavior."),
  reproduce: issueOptionalTextFlag("reproduce", "Steps to reproduce."),
  crashReportId: issueOptionalTextFlag(
    "crash-report-id",
    "Crash report ID printed by --create-ticket.",
  ),
  dockerServices: issueOptionalTextFlag(
    "docker-services",
    "Relevant Docker service status or logs.",
  ),
  additionalContext: issueCommonContextFlag,
  noBrowser: issueNoBrowserFlag,
} as const;

const issueFeatureConfig = {
  existingIssues: Flag.boolean("existing-issues").pipe(
    Flag.withDescription("Prefill the existing issues checklist."),
    Flag.withDefault(false),
  ),
  area: issueOptionalTextFlag("area", "Affected CLI area."),
  problem: issueOptionalTextFlag("problem", "Problem the feature should solve."),
  proposedSolution: issueOptionalTextFlag("proposed-solution", "Proposed solution."),
  alternatives: issueOptionalTextFlag("alternatives", "Alternatives considered."),
  additionalContext: issueCommonContextFlag,
  noBrowser: issueNoBrowserFlag,
} as const;

const issueDocsConfig = {
  link: issueOptionalTextFlag("link", "Relevant documentation link."),
  issueType: issueOptionalTextFlag("issue-type", "Documentation issue type."),
  problem: issueOptionalTextFlag("problem", "What is confusing, missing, or incorrect."),
  improvement: issueOptionalTextFlag("improvement", "Suggested documentation improvement."),
  additionalContext: issueCommonContextFlag,
  noBrowser: issueNoBrowserFlag,
} as const;

export type IssueBugFlags = CliCommand.Command.Config.Infer<typeof issueBugConfig>;
export type IssueFeatureFlags = CliCommand.Command.Config.Infer<typeof issueFeatureConfig>;
export type IssueDocsFlags = CliCommand.Command.Config.Infer<typeof issueDocsConfig>;

const issueBugCommand = Command.make("bug", issueBugConfig).pipe(
  Command.withDescription("Open a GitHub bug report with local CLI details prefilled."),
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
  Command.withHandler((flags) =>
    issueBug(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["issue", "bug"])),
  Command.provide(browserLayer),
);

const issueFeatureCommand = Command.make("feature", issueFeatureConfig).pipe(
  Command.withDescription("Open a GitHub feature request with useful context prefilled."),
  Command.withShortDescription("Open a feature request"),
  Command.withExamples([
    {
      command:
        'supabase issue feature --existing-issues --problem "I need to rotate local secrets" --proposed-solution "Add a secrets rotate command"',
      description: "Open a prefilled feature request",
    },
  ]),
  Command.withHandler((flags) =>
    issueFeature(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["issue", "feature"])),
  Command.provide(browserLayer),
);

const issueDocsCommand = Command.make("docs", issueDocsConfig).pipe(
  Command.withDescription("Open a GitHub documentation issue with useful context prefilled."),
  Command.withShortDescription("Open a documentation issue"),
  Command.withExamples([
    {
      command:
        'supabase issue docs --link "https://supabase.com/docs/guides/cli" --problem "The flag description is outdated"',
      description: "Open a prefilled documentation issue",
    },
  ]),
  Command.withHandler((flags) =>
    issueDocs(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["issue", "docs"])),
  Command.provide(browserLayer),
);

export const issueCommand = Command.make("issue").pipe(
  Command.withDescription("Open Supabase CLI GitHub issue forms."),
  Command.withShortDescription("Open GitHub issue forms"),
  Command.withSubcommands([issueBugCommand, issueFeatureCommand, issueDocsCommand]),
);
