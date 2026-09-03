import {
  makeContainerEngineCodecs,
  makeContainerEngineCore,
  type ContainerCommand,
  type ContainerEngine,
  type ContainerEngineOptions,
  type ContainerLogOptions,
  type ContainerLabels,
  type ContainerProcessRequest,
} from "./ContainerEngine.ts";

const stackLabel = "com.supabase.stack.stackId";
const ownerLabel = "com.supabase.stack.ownerSessionId";
const workloadLabel = "com.supabase.stack.workloadId";
const startupLabel = "com.supabase.stack.startup";
const roleLabel = "com.supabase.stack.role";

const labels = (value: ContainerLabels): ReadonlyArray<string> => {
  const pairs =
    value.role === "network"
      ? [
          ["stackId", value.stackId],
          ["ownerSessionId", value.ownerSessionId],
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
            ["workloadId", value.workloadId],
            ["startup", value.startup === true ? "true" : "false"],
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
  templateLabel(workloadLabel),
  templateLabel(startupLabel),
  templateLabel(roleLabel),
  "{{.State}}",
].join("\\t");
const networkFormat = [
  "{{.ID}}",
  "{{.Name}}",
  templateMapLabel(stackLabel),
  templateMapLabel(ownerLabel),
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
      const entrypoint =
        command.spec.entrypoint === undefined ? [] : ["--entrypoint", command.spec.entrypoint];
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
          ...entrypoint,
          command.spec.image,
          ...(command.spec.command ?? []),
        ],
      };
    }
    case "copy-container":
      return { args: ["cp", command.source, `${command.id}:${command.destination}`] };
    case "start-container":
      return { args: ["start", command.id] };
    case "wait-container":
      return { args: ["wait", command.id] };
    case "stop-container":
      return { args: ["stop", command.id] };
    case "remove-container":
      return { args: ["rm", "--force", command.id] };
  }
};

const serializePodmanLogs = (
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

export const makePodmanEngine = (
  options: Omit<ContainerEngineOptions, "kind" | "codecs">,
): ContainerEngine =>
  makeContainerEngineCore({
    ...options,
    kind: "podman",
    codecs: makeContainerEngineCodecs({
      engineName: "Podman",
      scalarFormat: "raw",
      serialize: serializePodmanCommand,
      serializeLogs: serializePodmanLogs,
    }),
  });
