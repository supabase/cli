import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";
import { browserLayer } from "../../../shared/runtime/browser.layer.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../telemetry/legacy-command-instrumentation.ts";
import { legacyIssueBug, legacyIssueDocs, legacyIssueFeature } from "./issue.handler.ts";

const legacyIssueNoBrowserFlag = Flag.boolean("no-browser").pipe(
  Flag.withDescription("Print the issue form URL without opening a browser."),
);

const legacyIssueOptionalTextFlag = (name: string, description: string) =>
  Flag.string(name).pipe(Flag.withDescription(description), Flag.optional);

const legacyIssueCommonContextFlag = legacyIssueOptionalTextFlag(
  "additional-context",
  "Extra context to prefill on the issue form.",
);

const legacyIssueBugConfig = {
  area: legacyIssueOptionalTextFlag("area", "Affected CLI area."),
  command: legacyIssueOptionalTextFlag("command", "Command that failed."),
  actualOutput: legacyIssueOptionalTextFlag("actual-output", "Actual output or error text."),
  expectedBehavior: legacyIssueOptionalTextFlag("expected-behavior", "Expected behavior."),
  reproduce: legacyIssueOptionalTextFlag("reproduce", "Steps to reproduce."),
  crashReportId: legacyIssueOptionalTextFlag(
    "crash-report-id",
    "Crash report ID printed by --create-ticket.",
  ),
  dockerServices: legacyIssueOptionalTextFlag(
    "docker-services",
    "Relevant Docker service status or logs.",
  ),
  additionalContext: legacyIssueCommonContextFlag,
  noBrowser: legacyIssueNoBrowserFlag,
} as const;

const legacyIssueFeatureConfig = {
  existingIssues: Flag.boolean("existing-issues").pipe(
    Flag.withDescription("Prefill the existing issues checklist."),
  ),
  area: legacyIssueOptionalTextFlag("area", "Affected CLI area."),
  problem: legacyIssueOptionalTextFlag("problem", "Problem the feature should solve."),
  proposedSolution: legacyIssueOptionalTextFlag("proposed-solution", "Proposed solution."),
  alternatives: legacyIssueOptionalTextFlag("alternatives", "Alternatives considered."),
  additionalContext: legacyIssueCommonContextFlag,
  noBrowser: legacyIssueNoBrowserFlag,
} as const;

const legacyIssueDocsConfig = {
  link: legacyIssueOptionalTextFlag("link", "Relevant documentation link."),
  issueType: legacyIssueOptionalTextFlag("issue-type", "Documentation issue type."),
  problem: legacyIssueOptionalTextFlag("problem", "What is confusing, missing, or incorrect."),
  improvement: legacyIssueOptionalTextFlag("improvement", "Suggested documentation improvement."),
  additionalContext: legacyIssueCommonContextFlag,
  noBrowser: legacyIssueNoBrowserFlag,
} as const;

export type LegacyIssueBugFlags = CliCommand.Command.Config.Infer<typeof legacyIssueBugConfig>;
export type LegacyIssueFeatureFlags = CliCommand.Command.Config.Infer<
  typeof legacyIssueFeatureConfig
>;
export type LegacyIssueDocsFlags = CliCommand.Command.Config.Infer<typeof legacyIssueDocsConfig>;

const legacyIssueBugCommand = Command.make("bug", legacyIssueBugConfig).pipe(
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
    legacyIssueBug(flags).pipe(withLegacyCommandInstrumentation({ flags }), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["issue", "bug"])),
  Command.provide(browserLayer),
);

const legacyIssueFeatureCommand = Command.make("feature", legacyIssueFeatureConfig).pipe(
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
    legacyIssueFeature(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(commandRuntimeLayer(["issue", "feature"])),
  Command.provide(browserLayer),
);

const legacyIssueDocsCommand = Command.make("docs", legacyIssueDocsConfig).pipe(
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
    legacyIssueDocs(flags).pipe(withLegacyCommandInstrumentation({ flags }), withJsonErrorHandling),
  ),
  Command.provide(commandRuntimeLayer(["issue", "docs"])),
  Command.provide(browserLayer),
);

export const legacyIssueCommand = Command.make("issue").pipe(
  Command.withDescription("Open Supabase CLI GitHub issue forms."),
  Command.withShortDescription("Open GitHub issue forms"),
  Command.withSubcommands([
    legacyIssueBugCommand,
    legacyIssueFeatureCommand,
    legacyIssueDocsCommand,
  ]),
);
