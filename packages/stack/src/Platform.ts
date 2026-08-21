import { Effect } from "effect";

export interface PlatformInfo {
  readonly os: string;
  readonly arch: string;
}

/** Native slim-service release targets. The release set intentionally has no
 * windows or x64 macOS artifacts. */
export type NativeTarget = "darwin-arm64" | "linux-amd64" | "linux-arm64";

export const nativeTargetForPlatform = (platform: PlatformInfo): NativeTarget | undefined => {
  if (platform.os === "darwin" && platform.arch === "arm64") return "darwin-arm64";
  if (platform.os === "linux" && platform.arch === "x64") return "linux-amd64";
  if (platform.os === "linux" && platform.arch === "arm64") return "linux-arm64";
  return undefined;
};

export const detectPlatform: Effect.Effect<PlatformInfo> = Effect.sync(() => ({
  os: process.platform,
  arch: process.arch,
}));

/** Host address that Docker containers should use to reach services on the host machine. */
export const dockerHostAddress = (_os: string): string => "host.docker.internal";

const dockerHostGatewayArgs = (os: string): readonly string[] =>
  os === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : [];

/**
 * Docker networking args. We publish ports on every platform so container ports stay fixed
 * and host ports can be randomized consistently. Linux needs an explicit host-gateway alias
 * for host.docker.internal; Docker Desktop provides that name on macOS/Windows.
 */
export const dockerNetworkArgs = (os: string, ports: readonly number[]): readonly string[] =>
  dockerPortMapArgs(
    os,
    ports.map((port) => ({ host: port, container: port })),
  );

export const dockerPortMapArgs = (
  os: string,
  mappings: ReadonlyArray<{
    readonly host: number;
    readonly container: number;
  }>,
): readonly string[] => [
  ...dockerHostGatewayArgs(os),
  ...mappings.flatMap(({ host, container }) => ["-p", `${host}:${container}`]),
];
