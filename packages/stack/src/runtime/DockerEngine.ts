import {
  makeContainerEngineCodecs,
  makeContainerEngineCore,
  CONTAINER_LABEL_KEYS,
  serializeCommonContainerCommand,
  type ContainerCommand,
  type ContainerEngine,
  type ContainerEngineOptions,
  type ContainerProcessRequest,
} from "./ContainerEngine.ts";

const jsonLabel = (label: string): string => `{{json (.Label "${label}")}}`;

// Emit a closed set of JSON scalar fields. In particular, do not decode the
// daemon's raw `.Labels` map: unknown labels must never become runtime state.
const containerFormat = [
  "{{json .ID}}",
  "{{json .Names}}",
  jsonLabel(CONTAINER_LABEL_KEYS.stackId),
  jsonLabel(CONTAINER_LABEL_KEYS.ownerSessionId),
  jsonLabel(CONTAINER_LABEL_KEYS.workloadId),
  jsonLabel(CONTAINER_LABEL_KEYS.startup),
  jsonLabel(CONTAINER_LABEL_KEYS.role),
  "{{json .State}}",
].join("\\t");
const networkFormat = [
  "{{json .ID}}",
  "{{json .Name}}",
  jsonLabel(CONTAINER_LABEL_KEYS.stackId),
  jsonLabel(CONTAINER_LABEL_KEYS.ownerSessionId),
  jsonLabel(CONTAINER_LABEL_KEYS.role),
].join("\\t");
const volumeFormat = [
  "{{json .Name}}",
  jsonLabel(CONTAINER_LABEL_KEYS.stackId),
  jsonLabel(CONTAINER_LABEL_KEYS.workloadId),
  jsonLabel(CONTAINER_LABEL_KEYS.role),
].join("\\t");

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
          `label=${CONTAINER_LABEL_KEYS.stackId}=${command.stackId}`,
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
          `label=${CONTAINER_LABEL_KEYS.stackId}=${command.stackId}`,
          "--format",
          networkFormat,
        ],
      };
    case "inspect-network-gateway":
      return { args: ["network", "inspect", command.id, "--format", "{{json .IPAM.Config}}"] };
    case "inspect-volumes":
      return {
        args: [
          "volume",
          "ls",
          "--filter",
          `label=${CONTAINER_LABEL_KEYS.stackId}=${command.stackId}`,
          "--format",
          volumeFormat,
        ],
      };
    default:
      return serializeCommonContainerCommand(command);
  }
};

export const makeDockerEngine = (
  options: Omit<ContainerEngineOptions, "kind" | "codecs">,
): ContainerEngine =>
  makeContainerEngineCore({
    ...options,
    kind: "docker",
    codecs: makeContainerEngineCodecs({
      engineName: "Docker",
      scalarFormat: "json",
      serialize: serializeDockerCommand,
    }),
  });
