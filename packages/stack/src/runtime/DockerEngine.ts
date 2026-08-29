import { Effect, Schema } from "effect";
import { StackIdSchema, type StackId } from "../public/StackId.ts";
import {
  makeContainerEngineCore,
  type ContainerCommand,
  type ContainerCommandResult,
  type ContainerEngine,
  type ContainerEngineFailure,
  type ContainerEngineOptions,
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

const jsonLabel = (label: string): string => `{{json (.Label "${label}")}}`;

// Emit a closed set of JSON scalar fields. In particular, do not decode the
// daemon's raw `.Labels` map: unknown labels must never become runtime state.
const containerFormat = [
  "{{json .ID}}",
  "{{json .Names}}",
  jsonLabel(stackLabel),
  jsonLabel(ownerLabel),
  jsonLabel(generationLabel),
  jsonLabel(workloadLabel),
  jsonLabel(hashLabel),
  jsonLabel(roleLabel),
  "{{json .State}}",
].join("\\t");
const networkFormat = [
  "{{json .ID}}",
  "{{json .Name}}",
  jsonLabel(stackLabel),
  jsonLabel(ownerLabel),
  jsonLabel(generationLabel),
  jsonLabel(roleLabel),
].join("\\t");
const volumeFormat = [
  "{{json .Name}}",
  jsonLabel(stackLabel),
  jsonLabel(workloadLabel),
  jsonLabel(roleLabel),
].join("\\t");

const commandLabels = (spec: { readonly labels: ContainerLabels }): ReadonlyArray<string> =>
  labels(spec.labels);

export const serializeDockerCommand = (command: ContainerCommand): ContainerProcessRequest => {
  switch (command.operation) {
    case "probe":
      return { args: ["version", "--format", "{{json .Server.Version}}"] };
    case "inspect-image":
      return {
        args: ["image", "ls", command.image, "--format", "{{json .ID}}"],
      };
    case "pull-image":
      return { args: ["image", "pull", command.image] };
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
      const hostRoute =
        command.spec.hostRoute?.gateway === undefined
          ? []
          : ["--add-host", `${command.spec.hostRoute.host}:${command.spec.hostRoute.gateway}`];
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
          ...hostRoute,
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

const protocol = (operation: string, cause?: unknown): ContainerEngineProtocolError =>
  new ContainerEngineProtocolError({
    operation,
    message: `${operation} returned an invalid Docker response`,
    ...(cause === undefined ? {} : { cause }),
  });

const parseJson = (
  operation: string,
  raw: string,
): Effect.Effect<unknown, ContainerEngineFailure> =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(raw).pipe(
    Effect.mapError((cause) => protocol(operation, cause)),
  );

const lines = (raw: string): ReadonlyArray<string> =>
  raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const scalarString = (
  operation: string,
  raw: string,
): Effect.Effect<string, ContainerEngineFailure> =>
  parseJson(operation, raw).pipe(
    Effect.flatMap((value) =>
      typeof value === "string" && value.length > 0
        ? Effect.succeed(value)
        : Effect.fail(protocol(operation)),
    ),
  );

const fields = (
  operation: string,
  line: string,
  count: number,
): Effect.Effect<ReadonlyArray<string>, ContainerEngineFailure> => {
  const values = line.split(/\\t|\t/);
  if (values.length !== count) return Effect.fail(protocol(operation));
  return Effect.forEach(values, (value) =>
    parseJson(operation, value).pipe(
      Effect.flatMap((parsed) =>
        typeof parsed === "string" ? Effect.succeed(parsed) : Effect.fail(protocol(operation)),
      ),
    ),
  );
};

const decodeIdentity = (
  operation: string,
  stack: string | undefined,
): Effect.Effect<StackId, ContainerEngineFailure> => {
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

export const makeDockerCodecs = () => ({
  serialize: serializeDockerCommand,
  decodeProbe: (result: ContainerCommandResult) =>
    scalarString("probe", result.stdout).pipe(Effect.asVoid),
  decodeImage: (result: ContainerCommandResult) =>
    Effect.forEach(lines(result.stdout), (line) => scalarString("inspect-image", line)).pipe(
      Effect.map((values) => ({ present: values.length > 0 })),
    ),
  decodeContainers,
  decodeNetworks,
  decodeVolumes,
  decodeCreate,
});

export const createDockerEngine = (
  options: Omit<ContainerEngineOptions, "kind" | "codecs">,
): ContainerEngine =>
  makeContainerEngineCore({ ...options, kind: "docker", codecs: makeDockerCodecs() });
export const makeDockerEngine = createDockerEngine;
