import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { CLI_WORKDIR_LABEL } from "../../src/command-internal/docker-ids.ts";

interface DockerResult {
  readonly exitCode?: number;
  readonly stdout?: ReadonlyArray<string>;
  readonly stderr?: ReadonlyArray<string>;
}

interface DockerModelHooks {
  /** Runs before the daemon handles a command; a returned result replaces the daemon's answer. */
  readonly before?: (args: ReadonlyArray<string>) => Effect.Effect<DockerResult | undefined>;
  /** Runs after the daemon applied a command and before the CLI sees its exit. */
  readonly after?: (args: ReadonlyArray<string>) => Effect.Effect<void>;
}

interface ModelContainer {
  readonly name: string;
  readonly id: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly network: string | undefined;
  status: "created" | "running" | "exited";
}

const BUILT_IN_NETWORKS = new Set(["bridge", "host", "none", "default"]);

const STATE_JSON: Readonly<Record<ModelContainer["status"], string>> = {
  created: '{"Running":false,"Status":"created"}',
  running: '{"Running":true,"Status":"running","Health":{"Status":"healthy"}}',
  exited: '{"Running":false,"Status":"exited"}',
};

function flagValues(args: ReadonlyArray<string>, flag: string): ReadonlyArray<string> {
  const values: Array<string> = [];
  args.forEach((arg, index) => {
    const value = args[index + 1];
    if (arg === flag && value !== undefined) values.push(value);
  });
  return values;
}

function parseLabels(args: ReadonlyArray<string>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    flagValues(args, "--label").map((label) => {
      const separator = label.indexOf("=");
      return separator < 0 ? [label, ""] : [label.slice(0, separator), label.slice(separator + 1)];
    }),
  );
}

/** `--filter label=<key>` and `--filter label=<key>=<value>` selectors, ANDed like Docker does. */
function matchesLabelFilters(
  labels: Readonly<Record<string, string>>,
  args: ReadonlyArray<string>,
): boolean {
  return flagValues(args, "--filter")
    .filter((filter) => filter.startsWith("label="))
    .map((filter) => filter.slice("label=".length))
    .every((selector) => {
      const separator = selector.indexOf("=");
      const value = labels[separator < 0 ? selector : selector.slice(0, separator)];
      return value !== undefined && (separator < 0 || value === selector.slice(separator + 1));
    });
}

function containerId(name: string): string {
  return [...name]
    .map((char) => (char.codePointAt(0) ?? 0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);
}

/**
 * A stateful in-memory Docker daemon behind the `docker` CLI, covering what `start`, `stop` and
 * rollback ask of it. Networks and containers carry their labels, label-filtered `network prune`
 * removes only networks no container is attached to, and creating a container on a network that
 * does not exist fails the way the daemon does. Volumes always exist and every command it does not
 * model succeeds with no output.
 */
export function dockerModel(hooks: DockerModelHooks = {}) {
  const networks = new Map<string, Readonly<Record<string, string>>>();
  const containers = new Map<string, ModelContainer>();
  const commands: Array<ReadonlyArray<string>> = [];
  const encoder = new TextEncoder();

  const findContainer = (ref: string | undefined) =>
    ref === undefined
      ? undefined
      : (containers.get(ref) ?? [...containers.values()].find((container) => container.id === ref));

  const handle = (args: ReadonlyArray<string>): DockerResult => {
    const [command, subcommand] = args;

    if (command === "network" && subcommand === "inspect") {
      const name = args[2] ?? "";
      return networks.has(name)
        ? { exitCode: 0 }
        : { exitCode: 1, stderr: [`Error response from daemon: network ${name} not found`] };
    }
    if (command === "network" && subcommand === "create") {
      const name = args.at(-1) ?? "";
      if (networks.has(name)) {
        return {
          exitCode: 1,
          stderr: [`Error response from daemon: network with name ${name} already exists`],
        };
      }
      networks.set(name, parseLabels(args));
      return { exitCode: 0, stdout: [containerId(name)] };
    }
    if (command === "network" && subcommand === "prune") {
      const pruned = [...networks]
        .filter(
          ([name, labels]) =>
            matchesLabelFilters(labels, args) &&
            ![...containers.values()].some((container) => container.network === name),
        )
        .map(([name]) => name);
      for (const name of pruned) networks.delete(name);
      return { exitCode: 0, stdout: ["Deleted Networks:", ...pruned] };
    }

    if (command === "create") {
      const name = flagValues(args, "--name")[0] ?? `container-${commands.length}`;
      const network = flagValues(args, "--network")[0];
      if (network !== undefined && !BUILT_IN_NETWORKS.has(network) && !networks.has(network)) {
        return {
          exitCode: 1,
          stderr: [`Error response from daemon: network ${network} not found`],
        };
      }
      const container: ModelContainer = {
        name,
        id: containerId(name),
        labels: parseLabels(args),
        network,
        status: "created",
      };
      containers.set(name, container);
      return { exitCode: 0, stdout: [container.id] };
    }
    if (command === "start" || command === "stop") {
      const container = findContainer(args[1]);
      if (container === undefined) {
        return { exitCode: 1, stderr: [`Error: No such container: ${args[1] ?? ""}`] };
      }
      container.status = command === "start" ? "running" : "exited";
      return { exitCode: 0, stdout: [container.id] };
    }
    if (command === "container" && subcommand === "inspect") {
      const container = findContainer(args[2]);
      return container === undefined
        ? { exitCode: 1, stderr: [`Error: No such container: ${args[2] ?? ""}`] }
        : { exitCode: 0, stdout: [STATE_JSON[container.status]] };
    }
    if (command === "container" && subcommand === "prune") {
      const pruned = [...containers.values()].filter(
        (container) =>
          container.status !== "running" && matchesLabelFilters(container.labels, args),
      );
      for (const container of pruned) containers.delete(container.name);
      return { exitCode: 0, stdout: ["Deleted Containers:", ...pruned.map(({ id }) => id)] };
    }
    if (command === "ps") {
      const format = flagValues(args, "--format")[0] ?? "";
      const all = args.includes("--all");
      return {
        exitCode: 0,
        stdout: [...containers.values()]
          .filter(
            (container) =>
              (all || container.status === "running") &&
              matchesLabelFilters(container.labels, args),
          )
          .map((container) =>
            format.includes("{{.Label")
              ? [container.id, container.name, container.labels[CLI_WORKDIR_LABEL] ?? ""].join("\t")
              : format.includes("{{.Names}}")
                ? container.name
                : container.id,
          ),
      };
    }

    if (command === "version") {
      const format = flagValues(args, "--format")[0] ?? "";
      return {
        exitCode: 0,
        stdout: [
          format
            .replaceAll("{{.Client.APIVersion}}", "1.45")
            .replaceAll("{{.Server.APIVersion}}", "1.45"),
        ],
      };
    }
    if (command === "context" && subcommand === "inspect") return { exitCode: 1 };
    return { exitCode: 0 };
  };

  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const args = ChildProcess.isStandardCommand(command) ? command.args : [];
        commands.push(args);
        const override = hooks.before === undefined ? undefined : yield* hooks.before(args);
        const result = override ?? handle(args);
        if (override === undefined && hooks.after !== undefined) yield* hooks.after(args);

        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(6000 + commands.length),
          stdout: Stream.fromIterable(
            (result.stdout ?? []).map((line) => encoder.encode(`${line}\n`)),
          ),
          stderr: Stream.fromIterable(
            (result.stderr ?? []).map((line) => encoder.encode(`${line}\n`)),
          ),
          all: Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode ?? 0)),
          isRunning: Effect.succeed(false),
          stdin: Sink.drain,
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );

  return {
    layer,
    /** Argv of every command the CLI issued, in order. */
    commands: (): ReadonlyArray<ReadonlyArray<string>> => commands,
    networkNames: (): ReadonlyArray<string> => [...networks.keys()].sort(),
    containerNames: (): ReadonlyArray<string> => [...containers.keys()].sort(),
  };
}

export type DockerModel = ReturnType<typeof dockerModel>;
