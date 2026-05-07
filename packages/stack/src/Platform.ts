import { Effect } from "effect";

export interface PlatformInfo {
  readonly os: string;
  readonly arch: string;
}

export const detectPlatform: Effect.Effect<PlatformInfo> = Effect.sync(() => ({
  os: process.platform,
  arch: process.arch,
}));

export const postgresAssetName = (p: PlatformInfo): string | null => {
  if (p.os === "darwin" && p.arch === "arm64") return "darwin-arm64";
  if (p.os === "linux" && p.arch === "x64") return "linux-x64";
  if (p.os === "linux" && p.arch === "arm64") return "linux-arm64";
  return null;
};

export const postgrestAssetName = (p: PlatformInfo): string | null => {
  if (p.os === "darwin" && p.arch === "arm64") return "macos-aarch64";
  if (p.os === "linux" && p.arch === "x64") return "linux-static-x86-64";
  if (p.os === "linux" && p.arch === "arm64") return "ubuntu-aarch64";
  if (p.os === "win32" && p.arch === "x64") return "windows-x86-64";
  return null;
};

export const authAssetName = (p: PlatformInfo): string | null => {
  if (p.os === "darwin" && p.arch === "arm64") return "darwin-arm64";
  if (p.os === "linux" && p.arch === "x64") return "x86";
  if (p.os === "linux" && p.arch === "arm64") return "arm64";
  return null;
};

export const edgeRuntimeAssetName = (p: PlatformInfo): string | null => {
  if (p.os === "darwin" && p.arch === "arm64") return "aarch64-darwin";
  if (p.os === "linux" && p.arch === "x64") return "x86_64-linux";
  if (p.os === "linux" && p.arch === "arm64") return "aarch64-linux";
  return null;
};

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
