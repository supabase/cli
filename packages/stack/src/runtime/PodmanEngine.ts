import { Effect, Schema } from "effect";
import { StackIdSchema } from "../public/StackId.ts";
import {
  makeContainerEngineCore,
  type ContainerCommand,
  type ContainerCommandResult,
  type ContainerEngine,
  type ContainerEngineFailure,
  type ContainerEngineOptions,
  type ContainerLogOptions,
  type ContainerLabels,
  type ContainerNetworkLabels,
  type ContainerProcessRequest,
  type ContainerResource,
  type ContainerResourceRole,
  type ContainerWorkloadLabels,
} from "./ContainerEngine.ts";
import { ContainerEngineProtocolError } from "./ContainerEngine.ts";

const stackLabel = "com.supabase.stack.stackId";
const ownerLabel = "com.supabase.stack.ownerSessionId";
const generationLabel = "com.supabase.stack.desiredGeneration";
const workloadLabel = "com.supabase.stack.workloadId";
const hashLabel = "com.supabase.stack.specHash";
const roleLabel = "com.supabase.stack.role";

const labels = (value: ContainerLabels): ReadonlyArray<string> => {
  const pairs =
    value.role === "network"
      ? [
          ["stackId", value.stackId],
          ["ownerSessionId", value.ownerSessionId],
          ["desiredGeneration", value.desiredGeneration],
          ["role", value.role],
        ]
      : value.role === "volume"
        ? [
            ["stackId", value.stackId],
            ["workloadId", value.workloadId],
            ["role", value.role],
          ]
        : [
            ["stackId", value.stackId],
            ["ownerSessionId", value.ownerSessionId],
            ["desiredGeneration", value.desiredGeneration],
            ["workloadId", value.workloadId],
            ["specHash", value.specHash],
            ["role", value.role],
          ];
  return pairs.flatMap(([key, label]) => ["--label", `com.supabase.stack.${key}=${String(label)}`]);
};

const templateLabel = (label: string): string => `{{.Label "${label}"}}`;
const templateMapLabel = (label: string): string => `{{index .Labels "${label}"}}`;

// Podman has a separate documented Go-template contract. Delimited scalar
// fields avoid relying on its version-specific JSON row shape.
const containerFormat = [
  "{{.ID}}",
  "{{.Names}}",
  templateLabel(stackLabel),
  templateLabel(ownerLabel),
  templateLabel(generationLabel),
  templateLabel(workloadLabel),
  templateLabel(hashLabel),
  templateLabel(roleLabel),
  "{{.State}}",
].join("\\t");
const networkFormat = [
  "{{.ID}}",
  "{{.Name}}",
  templateMapLabel(stackLabel),
  templateMapLabel(ownerLabel),
  templateMapLabel(generationLabel),
  templateMapLabel(roleLabel),
].join("\\t");
const volumeFormat = [
  "{{.Name}}",
  templateMapLabel(stackLabel),
  templateMapLabel(workloadLabel),
  templateMapLabel(roleLabel),
].join("\\t");

const commandLabels = (spec: { readonly labels: ContainerLabels }): ReadonlyArray<string> =>
  labels(spec.labels);

export const serializePodmanCommand = (command: ContainerCommand): ContainerProcessRequest => {
  switch (command.operation) {
    case "probe":
      return { args: ["version", "--format", "{{.Version}}"] };
    case "inspect-image":
      return {
        args: ["image", "ls", command.image, "--format", "{{.ID}}"],
      };
    case "pull-image":
      return { args: ["pull", command.image] };
    case "inspect-containers":
      return {
        args: [
          "ps",
          "--all",
          "--filter",
          `label=${stackLabel}=${command.stackId}`,
          "--format",
          containerFormat,
        ],
      };
    case "inspect-networks":
      return {
        args: [
          "network",
          "ls",
          "--filter",
          `label=${stackLabel}=${command.stackId}`,
          "--format",
          networkFormat,
        ],
      };
    case "inspect-volumes":
      return {
        args: [
          "volume",
          "ls",
          "--filter",
          `label=${stackLabel}=${command.stackId}`,
          "--format",
          volumeFormat,
        ],
      };
    case "create-network":
      return { args: ["network", "create", ...commandLabels(command.spec), command.spec.name] };
    case "remove-network":
      return { args: ["network", "rm", command.id] };
    case "create-volume":
      return { args: ["volume", "create", ...commandLabels(command.spec), command.spec.name] };
    case "remove-volume":
      return { args: ["volume", "rm", command.id] };
    case "create-container": {
      const bindMounts = command.spec.mounts.flatMap((mount) => [
        "--mount",
        `type=bind,src=${mount.source},dst=${mount.target}${mount.readOnly ? ",ro" : ""}`,
      ]);
      const volumeMounts = command.spec.volumeMounts.flatMap((mount) => [
        "--mount",
        `type=volume,src=${mount.volume},dst=${mount.target}${mount.readOnly ? ",ro" : ""}`,
      ]);
      const publications = command.spec.publications.flatMap((port) => [
        "--publish",
        `${port.address}:${port.hostPort}:${port.containerPort}`,
      ]);
      const environment =
        command.spec.envFile === undefined ? [] : ["--env-file", command.spec.envFile];
      const networkAliases =
        command.spec.networkAliases === undefined
          ? []
          : command.spec.networkAliases.flatMap((alias) => ["--network-alias", alias]);
      return {
        args: [
          "create",
          "--name",
          command.spec.name,
          "--network",
          command.spec.network,
          ...networkAliases,
          ...commandLabels(command.spec),
          ...bindMounts,
          ...volumeMounts,
          ...publications,
          ...environment,
          command.spec.image,
          ...(command.spec.command ?? []),
        ],
      };
    }
    case "copy-container":
      return { args: ["cp", command.source, `${command.id}:${command.destination}`] };
    case "start-container":
      return { args: ["start", command.id] };
    case "stop-container":
      return { args: ["stop", command.id] };
    case "remove-container":
      return { args: ["rm", "--force", command.id] };
  }
};

export const serializePodmanLogs = (
  id: string,
  options: ContainerLogOptions | undefined,
): ContainerProcessRequest => ({
  args: [
    "logs",
    "--follow",
    "--tail",
    options?.tail === undefined ? "all" : String(options.tail),
    id,
  ],
});

const protocol = (operation: string, cause?: unknown): ContainerEngineProtocolError =>
  new ContainerEngineProtocolError({
    operation,
    message: `${operation} returned an invalid Podman response`,
    ...(cause === undefined ? {} : { cause }),
  });

const lines = (raw: string): ReadonlyArray<string> =>
  raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const scalar = (operation: string, raw: string): Effect.Effect<string, ContainerEngineFailure> => {
  const value = raw.trim();
  return value.length > 0 && !/\\t|\t/.test(value)
    ? Effect.succeed(value)
    : Effect.fail(protocol(operation));
};

const fields = (
  operation: string,
  line: string,
  count: number,
): Effect.Effect<ReadonlyArray<string>, ContainerEngineFailure> => {
  const values = line.split(/\\t|\t/);
  return values.length === count && values.every((value) => !/[\r\n]/.test(value))
    ? Effect.succeed(values)
    : Effect.fail(protocol(operation));
};

const decodeIdentity = (
  operation: string,
  stack: string | undefined,
): Effect.Effect<import("../public/StackId.ts").StackId, ContainerEngineFailure> => {
  if (stack === undefined) return Effect.fail(protocol(operation));
  return Schema.decodeEffect(StackIdSchema)(stack).pipe(
    Effect.mapError((error) => protocol(operation, error)),
  );
};

const networkLabels = (
  operation: string,
  values: ReadonlyArray<string>,
): Effect.Effect<ContainerNetworkLabels, ContainerEngineFailure> => {
  const [stack, owner, generation, role] = values;
  if (owner === undefined || generation === undefined || role !== "network")
    return Effect.fail(protocol(operation));
  return decodeIdentity(operation, stack).pipe(
    Effect.flatMap((stackId) => {
      const desiredGeneration = Number(generation);
      return Number.isInteger(desiredGeneration)
        ? Effect.succeed({
            stackId,
            ownerSessionId: owner,
            desiredGeneration,
            role: "network",
          })
        : Effect.fail(protocol(operation));
    }),
  );
};

const workloadLabels = (
  operation: string,
  values: ReadonlyArray<string>,
): Effect.Effect<ContainerWorkloadLabels, ContainerEngineFailure> => {
  const [stack, owner, generation, workload, hash, role] = values;
  if (
    owner === undefined ||
    generation === undefined ||
    workload === undefined ||
    hash === undefined ||
    role !== "workload"
  )
    return Effect.fail(protocol(operation));
  return decodeIdentity(operation, stack).pipe(
    Effect.flatMap((stackId) => {
      const desiredGeneration = Number(generation);
      return Number.isInteger(desiredGeneration)
        ? Effect.succeed({
            stackId,
            ownerSessionId: owner,
            desiredGeneration,
            workloadId: workload,
            specHash: hash,
            role,
          })
        : Effect.fail(protocol(operation));
    }),
  );
};

const decodeRows = <A>(
  operation: string,
  raw: string,
  count: number,
  decode: (values: ReadonlyArray<string>) => Effect.Effect<A, ContainerEngineFailure>,
): Effect.Effect<ReadonlyArray<A>, ContainerEngineFailure> =>
  Effect.forEach(lines(raw), (line) => fields(operation, line, count).pipe(Effect.flatMap(decode)));

const decodeContainers = (result: ContainerCommandResult) =>
  decodeRows("inspect-containers", result.stdout, 9, (values) => {
    const [id, name, stack, owner, generation, workload, hash, role, state] = values;
    if (
      id === undefined ||
      name === undefined ||
      stack === undefined ||
      owner === undefined ||
      generation === undefined ||
      workload === undefined ||
      hash === undefined ||
      role === undefined ||
      state === undefined ||
      role !== "workload"
    )
      return Effect.fail(protocol("inspect-containers"));
    return workloadLabels("inspect-containers", [
      stack,
      owner,
      generation,
      workload,
      hash,
      role,
    ]).pipe(
      Effect.map((labels): ContainerResource => ({
        id,
        name,
        kind: role,
        labels,
        state: state.includes("running") ? "running" : "stopped",
      })),
    );
  });

const decodeNetworks = (result: ContainerCommandResult) =>
  decodeRows("inspect-networks", result.stdout, 6, (values) => {
    const [id, name, stack, owner, generation, role] = values;
    if (id === undefined || name === undefined || role === undefined)
      return Effect.fail(protocol("inspect-networks"));
    return networkLabels("inspect-networks", [
      stack ?? "",
      owner ?? "",
      generation ?? "",
      role,
    ]).pipe(Effect.map((labels): ContainerResource => ({ id, name, kind: "network", labels })));
  });

const decodeVolumes = (result: ContainerCommandResult) =>
  decodeRows("inspect-volumes", result.stdout, 4, (values) => {
    const [name, stack, workload, role] = values;
    if (name === undefined || stack === undefined || workload === undefined || role === undefined)
      return Effect.fail(protocol("inspect-volumes"));
    return Schema.decodeEffect(StackIdSchema)(stack).pipe(
      Effect.mapError((error) => protocol("inspect-volumes", error)),
      Effect.flatMap((stackId) =>
        role === "volume"
          ? Effect.succeed<ContainerResource>({
              id: name,
              name,
              kind: "volume",
              labels: { stackId, workloadId: workload, role: "volume" },
            })
          : Effect.fail(protocol("inspect-volumes")),
      ),
    );
  });

const decodeCreate = <R extends ContainerResourceRole>(
  operation: string,
  result: ContainerCommandResult,
  spec: { readonly name: string; readonly labels: ContainerLabels },
  kind: R,
): Effect.Effect<ContainerResource, ContainerEngineFailure> => {
  const id = result.stdout.trim();
  return id.length > 0 && !/[\r\n]/.test(id)
    ? Effect.succeed({ id, name: spec.name, kind, labels: spec.labels, state: "created" })
    : Effect.fail(protocol(operation));
};

export const makePodmanCodecs = () => ({
  serialize: serializePodmanCommand,
  serializeLogs: serializePodmanLogs,
  decodeProbe: (result: ContainerCommandResult) =>
    scalar("probe", result.stdout).pipe(Effect.asVoid),
  decodeImage: (result: ContainerCommandResult) =>
    Effect.forEach(lines(result.stdout), (line) => scalar("inspect-image", line)).pipe(
      Effect.map((values) => ({ present: values.length > 0 })),
    ),
  decodeContainers,
  decodeNetworks,
  decodeVolumes,
  decodeCreate,
});

export const createPodmanEngine = (
  options: Omit<ContainerEngineOptions, "kind" | "codecs">,
): ContainerEngine =>
  makeContainerEngineCore({ ...options, kind: "podman", codecs: makePodmanCodecs() });
export const makePodmanEngine = createPodmanEngine;
