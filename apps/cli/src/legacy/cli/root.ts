import { Effect, Layer, Option } from "effect";
import { Command } from "effect/unstable/cli";
import { legacyBackupsCommand } from "../commands/backups/backups.command.ts";
import { legacyBootstrapCommand } from "../commands/bootstrap/bootstrap.command.ts";
import { legacyBranchesCommand } from "../commands/branches/branches.command.ts";
import { legacyCompletionCommand } from "../commands/completion/completion.command.ts";
import { legacyConfigCommand } from "../commands/config/config.command.ts";
import { legacyDbCommand } from "../commands/db/db.command.ts";
import { legacyDomainsCommand } from "../commands/domains/domains.command.ts";
import { legacyEncryptionCommand } from "../commands/encryption/encryption.command.ts";
import { legacyFunctionsCommand } from "../commands/functions/functions.command.ts";
import { legacyGenCommand } from "../commands/gen/gen.command.ts";
import { legacyInitCommand } from "../commands/init/init.command.ts";
import { legacyInspectCommand } from "../commands/inspect/inspect.command.ts";
import { legacyIssueCommand } from "../commands/issue/issue.command.ts";
import { legacyLinkCommand } from "../commands/link/link.command.ts";
import { legacyLoginCommand } from "../commands/login/login.command.ts";
import { legacyLogoutCommand } from "../commands/logout/logout.command.ts";
import { legacyMigrationCommand } from "../commands/migration/migration.command.ts";
import { legacyNetworkBansCommand } from "../commands/network-bans/network-bans.command.ts";
import { legacyNetworkRestrictionsCommand } from "../commands/network-restrictions/network-restrictions.command.ts";
import { legacyOrgsCommand } from "../commands/orgs/orgs.command.ts";
import { legacyPostgresConfigCommand } from "../commands/postgres-config/postgres-config.command.ts";
import { legacyProjectsCommand } from "../commands/projects/projects.command.ts";
import { legacySecretsCommand } from "../commands/secrets/secrets.command.ts";
import { legacySeedCommand } from "../commands/seed/seed.command.ts";
import { legacyServicesCommand } from "../commands/services/services.command.ts";
import { legacySnippetsCommand } from "../commands/snippets/snippets.command.ts";
import { legacySslEnforcementCommand } from "../commands/ssl-enforcement/ssl-enforcement.command.ts";
import { legacySsoCommand } from "../commands/sso/sso.command.ts";
import { legacyStartCommand } from "../commands/start/start.command.ts";
import { legacyStatusCommand } from "../commands/status/status.command.ts";
import { legacyStopCommand } from "../commands/stop/stop.command.ts";
import { legacyStorageCommand } from "../commands/storage/storage.command.ts";
import { legacyTestCommand } from "../commands/test/test.command.ts";
import { legacyTelemetryCommand } from "../commands/telemetry/telemetry.command.ts";
import { legacyUnlinkCommand } from "../commands/unlink/unlink.command.ts";
import { legacyVanitySubdomainsCommand } from "../commands/vanity-subdomains/vanity-subdomains.command.ts";
import { OutputFormatFlag } from "../../shared/cli/global-flags.ts";
import { outputLayerFor } from "../../shared/output/output.layer.ts";
import { legacyQuietProgressTextOutputLayer } from "../output/legacy-quiet-progress-text-output.layer.ts";
import { makeGoProxyLayer } from "../../shared/legacy/go-proxy.layer.ts";
import { AiTool } from "../../shared/telemetry/ai-tool.service.ts";
import { aiToolLayer } from "../../shared/telemetry/ai-tool.layer.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { isBuiltInTextRequest, resolveAgentOutputFormat } from "../../shared/cli/agent-output.ts";
import {
  LEGACY_GLOBAL_FLAGS,
  LegacyAgentFlag,
  LegacyCreateTicketFlag,
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
  LegacyOutputFlag,
  LegacyProfileFlag,
  LegacyWorkdirFlag,
  LegacyYesFlag,
} from "../../shared/legacy/global-flags.ts";

export const legacyRoot = Command.make("supabase").pipe(
  Command.withDescription("Supabase CLI (stable channel)."),
  Command.withGlobalFlags([OutputFormatFlag, ...LEGACY_GLOBAL_FLAGS]),
  Command.withSubcommands([
    legacyBackupsCommand,
    legacyBootstrapCommand,
    legacyBranchesCommand,
    legacyCompletionCommand,
    legacyConfigCommand,
    legacyDbCommand,
    legacyDomainsCommand,
    legacyEncryptionCommand,
    legacyFunctionsCommand,
    legacyGenCommand,
    legacyInitCommand,
    legacyInspectCommand,
    legacyIssueCommand,
    legacyLinkCommand,
    legacyLoginCommand,
    legacyLogoutCommand,
    legacyMigrationCommand,
    legacyNetworkBansCommand,
    legacyNetworkRestrictionsCommand,
    legacyOrgsCommand,
    legacyPostgresConfigCommand,
    legacyProjectsCommand,
    legacySecretsCommand,
    legacySeedCommand,
    legacyServicesCommand,
    legacySnippetsCommand,
    legacySslEnforcementCommand,
    legacySsoCommand,
    legacyStartCommand,
    legacyStatusCommand,
    legacyStopCommand,
    legacyStorageCommand,
    legacyTelemetryCommand,
    legacyTestCommand,
    legacyUnlinkCommand,
    legacyVanitySubdomainsCommand,
  ]),
  Command.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const explicitOutputFormat = yield* OutputFormatFlag;
        const goOutput = yield* LegacyOutputFlag;
        const profile = yield* LegacyProfileFlag;
        const debug = yield* LegacyDebugFlag;
        const workdir = yield* LegacyWorkdirFlag;
        const experimental = yield* LegacyExperimentalFlag;
        const networkId = yield* LegacyNetworkIdFlag;
        const yes = yield* LegacyYesFlag;
        const dnsResolver = yield* LegacyDnsResolverFlag;
        const createTicket = yield* LegacyCreateTicketFlag;
        const agent = yield* LegacyAgentFlag;
        const cliArgs = yield* CliArgs;

        const aiTool = yield* AiTool.pipe(Effect.provide(aiToolLayer));
        // An explicit Go --output is a complete format choice (even `-o pretty`
        // must keep its human table), so the agent JSON default only applies
        // when that flag is absent.
        const outputFormat = resolveAgentOutputFormat({
          explicitOutputFormat,
          legacyOutputFormat: goOutput,
          agentOverride: agent,
          detectedAgentName: aiTool.name,
          isBuiltInTextRequest: isBuiltInTextRequest(cliArgs.args),
        });

        // Build args to prepend to every proxy exec call.
        // --output: use explicit --output if set, otherwise map from --output-format.
        const globalArgs: string[] = [];
        if (Option.isSome(goOutput)) {
          globalArgs.push("--output", goOutput.value);
        } else if (outputFormat !== "text") {
          globalArgs.push("--output", "json");
        }
        if (profile !== "supabase") globalArgs.push("--profile", profile);
        if (debug) globalArgs.push("--debug");
        if (Option.isSome(workdir)) globalArgs.push("--workdir", workdir.value);
        if (experimental) globalArgs.push("--experimental");
        if (Option.isSome(networkId)) globalArgs.push("--network-id", networkId.value);
        if (yes) globalArgs.push("--yes");
        if (dnsResolver !== "native") globalArgs.push("--dns-resolver", dnsResolver);
        if (createTicket) globalArgs.push("--create-ticket");
        if (agent !== "auto") globalArgs.push("--agent", agent);

        // Go's `-o {json,yaml,toml,env,csv}` selects a machine encoder the
        // handler writes via `output.raw`. Keep the text layer (so errors still
        // render as red text on stderr, matching Go), but suppress its progress
        // spinner — otherwise clack writes ANSI to stdout and corrupts the
        // payload (CLI-1546). `-o pretty` / `-o table` (`db query`'s human
        // default) / no `-o` keep the normal text/json layers.
        const goFmt = Option.getOrUndefined(goOutput);
        const isGoMachineFormat = goFmt !== undefined && goFmt !== "pretty" && goFmt !== "table";
        const outputLayer = isGoMachineFormat
          ? legacyQuietProgressTextOutputLayer
          : outputLayerFor(outputFormat);

        return Layer.mergeAll(outputLayer, makeGoProxyLayer({ globalArgs }));
      }),
    ),
  ),
);
