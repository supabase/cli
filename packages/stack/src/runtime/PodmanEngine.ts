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

const templateLabel = (label: string): string => `{{.Label "${label}"}}`;
const templateMapLabel = (label: string): string => `{{index .Labels "${label}"}}`;

// Podman has a separate documented Go-template contract. Delimited scalar
// fields avoid relying on its version-specific JSON row shape.
const containerFormat = [
  "{{.ID}}",
  "{{.Names}}",
  templateLabel(CONTAINER_LABEL_KEYS.stackId),
  templateLabel(CONTAINER_LABEL_KEYS.ownerSessionId),
  templateLabel(CONTAINER_LABEL_KEYS.workloadId),
  templateLabel(CONTAINER_LABEL_KEYS.startup),
  templateLabel(CONTAINER_LABEL_KEYS.role),
  "{{.State}}",
].join("\\t");
const networkFormat = [
  "{{.ID}}",
  "{{.Name}}",
  templateMapLabel(CONTAINER_LABEL_KEYS.stackId),
  templateMapLabel(CONTAINER_LABEL_KEYS.ownerSessionId),
  templateMapLabel(CONTAINER_LABEL_KEYS.role),
].join("\\t");
const volumeFormat = [
  "{{.Name}}",
  templateMapLabel(CONTAINER_LABEL_KEYS.stackId),
  templateMapLabel(CONTAINER_LABEL_KEYS.workloadId),
  templateMapLabel(CONTAINER_LABEL_KEYS.role),
].join("\\t");

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
      return { args: ["network", "inspect", command.id, "--format", "{{json .Subnets}}"] };
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
    }),
  });
