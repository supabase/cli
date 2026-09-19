/** Selects native execution where the catalog publishes portable artifacts. */
export const defaultStackRuntime = (runtime: {
  readonly platform: string;
  readonly arch: string;
}): "native" | "docker" =>
  (runtime.platform === "linux" && (runtime.arch === "x64" || runtime.arch === "arm64")) ||
  (runtime.platform === "darwin" && runtime.arch === "arm64")
    ? "native"
    : "docker";
