import { Effect, Layer, Option } from "effect";
import { Command } from "effect/unstable/cli";
import { backupsCommand } from "../commands/backups/backups.command.ts";
import { bootstrapCommand } from "../commands/bootstrap/bootstrap.command.ts";
import { branchesCommand } from "../commands/branches/branches.command.ts";
import { completionCommand } from "../commands/completion/completion.command.ts";
import { configCommand } from "../commands/config/config.command.ts";
import { dbCommand } from "../commands/db/db.command.ts";
import { domainsCommand } from "../commands/domains/domains.command.ts";
import { encryptionCommand } from "../commands/encryption/encryption.command.ts";
import { stackRuntimeLayer, stackCommand } from "../commands/experimental/stack/stack.command.ts";
import { stackStartCommand } from "../commands/experimental/stack/start/start.command.ts";
import { stackStopCommand } from "../commands/experimental/stack/stop/stop.command.ts";
import type { StackBackend } from "../commands/experimental/stack/stack-backend.ts";
import { computeCommand } from "../commands/experimental/compute/compute.command.ts";
import { functionsCommand } from "../commands/functions/functions.command.ts";
import { genCommand } from "../commands/gen/gen.command.ts";
import { initCommand } from "../commands/init/init.command.ts";
import { inspectCommand } from "../commands/inspect/inspect.command.ts";
import { issueCommand } from "../commands/issue/issue.command.ts";
import { linkCommand } from "../commands/link/link.command.ts";
import { loginCommand } from "../commands/login/login.command.ts";
import { logoutCommand } from "../commands/logout/logout.command.ts";
import { migrationCommand } from "../commands/migration/migration.command.ts";
import { networkBansCommand } from "../commands/network-bans/network-bans.command.ts";
import { networkRestrictionsCommand } from "../commands/network-restrictions/network-restrictions.command.ts";
import { orgsCommand } from "../commands/orgs/orgs.command.ts";
import { postgresConfigCommand } from "../commands/postgres-config/postgres-config.command.ts";
import { projectsCommand } from "../commands/projects/projects.command.ts";
import { pullCommand } from "../commands/pull/pull.command.ts";
import { secretsCommand } from "../commands/secrets/secrets.command.ts";
import { seedCommand } from "../commands/seed/seed.command.ts";
import { servicesCommand } from "../commands/services/services.command.ts";
import { snippetsCommand } from "../commands/snippets/snippets.command.ts";
import { sslEnforcementCommand } from "../commands/ssl-enforcement/ssl-enforcement.command.ts";
import { ssoCommand } from "../commands/sso/sso.command.ts";
import { startCommand } from "../commands/start/start.command.ts";
import { statusCommand } from "../commands/status/status.command.ts";
import { stopCommand } from "../commands/stop/stop.command.ts";
import { storageCommand } from "../commands/storage/storage.command.ts";
import { testCommand } from "../commands/test/test.command.ts";
import { telemetryCommand } from "../commands/telemetry/telemetry.command.ts";
import { unlinkCommand } from "../commands/unlink/unlink.command.ts";
import { vanitySubdomainsCommand } from "../commands/vanity-subdomains/vanity-subdomains.command.ts";
import { whoamiCommand } from "../commands/whoami/whoami.command.ts";
import { OutputFormatFlag } from "../shared/cli/global-flags.ts";
import { outputLayerFor } from "../shared/output/output.layer.ts";
import { quietProgressTextOutputLayer } from "../output/quiet-progress-text-output.layer.ts";
import { makeGoProxyLayer } from "../command-internal/go-proxy.layer.ts";
import { AiTool } from "../shared/telemetry/ai-tool.service.ts";
import { aiToolLayer } from "../shared/telemetry/ai-tool.layer.ts";
import { CliArgs } from "../shared/cli/cli-args.service.ts";
import { commandRuntimeLayer } from "../shared/runtime/command-runtime.layer.ts";
import type { CliRootCommand } from "../shared/cli/run.ts";
import { isBuiltInTextRequest, resolveAgentOutputFormat } from "../shared/cli/agent-output.ts";
import {
  GLOBAL_FLAGS,
  AgentFlag,
  CreateTicketFlag,
  DebugFlag,
  DnsResolverFlag,
  ExperimentalFlag,
  NetworkIdFlag,
  OutputFlag,
  ProfileFlag,
  WorkdirFlag,
  YesFlag,
} from "../command-internal/global-flags.ts";

const stackStartAliasCommand = stackStartCommand.pipe(
  Command.provide(commandRuntimeLayer(["start"])),
  Command.provide(stackRuntimeLayer),
);
export const stackStopAliasCommand = stackStopCommand.pipe(
  Command.provide(commandRuntimeLayer(["stop"])),
  Command.provide(stackRuntimeLayer),
);

export const rootCommandForFeatures = (
  options: {
    readonly stackBackend?: StackBackend;
    readonly computeEnabled?: boolean;
  } = {},
): CliRootCommand =>
  Command.make("supabase").pipe(
    Command.withDescription("Supabase CLI (stable channel)."),
    Command.withSubcommands([
      backupsCommand,
      bootstrapCommand,
      branchesCommand,
      completionCommand,
      configCommand,
      dbCommand,
      domainsCommand,
      encryptionCommand,
      ...(options.computeEnabled ? [computeCommand] : []),
      functionsCommand,
      genCommand,
      initCommand,
      inspectCommand,
      issueCommand,
      linkCommand,
      loginCommand,
      logoutCommand,
      migrationCommand,
      networkBansCommand,
      networkRestrictionsCommand,
      orgsCommand,
      postgresConfigCommand,
      projectsCommand,
      pullCommand,
      secretsCommand,
      seedCommand,
      servicesCommand,
      snippetsCommand,
      sslEnforcementCommand,
      ssoCommand,
      stackCommand,
      options.stackBackend === "stack" ? stackStartAliasCommand : startCommand,
      statusCommand,
      options.stackBackend === "stack" ? stackStopAliasCommand : stopCommand,
      storageCommand,
      telemetryCommand,
      testCommand,
      unlinkCommand,
      vanitySubdomainsCommand,
      whoamiCommand,
    ]),
    Command.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const explicitOutputFormat = yield* OutputFormatFlag;
          const goOutput = yield* OutputFlag;
          const profile = yield* ProfileFlag;
          const debug = yield* DebugFlag;
          const workdir = yield* WorkdirFlag;
          const experimental = yield* ExperimentalFlag;
          const networkId = yield* NetworkIdFlag;
          const yes = yield* YesFlag;
          const dnsResolver = yield* DnsResolverFlag;
          const createTicket = yield* CreateTicketFlag;
          const agent = yield* AgentFlag;
          const cliArgs = yield* CliArgs;

          const aiTool = yield* AiTool.pipe(Effect.provide(aiToolLayer));
          // An explicit Go --output is a complete format choice (even `-o pretty`
          // must keep its human table), so the agent JSON default only applies
          // when that flag is absent.
          const outputFormat = resolveAgentOutputFormat({
            explicitOutputFormat,
            goOutputFormat: goOutput,
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
            ? quietProgressTextOutputLayer
            : outputLayerFor(outputFormat);

          return Layer.mergeAll(
            outputLayer,
            makeGoProxyLayer({ globalArgs, parentOwnsCapturedSuccessTail: true }),
          );
        }),
      ),
    ),
    Command.withGlobalFlags([OutputFormatFlag, ...GLOBAL_FLAGS]),
  );

export const rootCommand: CliRootCommand = rootCommandForFeatures();
