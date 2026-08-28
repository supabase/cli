import type { Schema } from "effect";
import type { CapabilityName, ActivationMode } from "../public/Capability.ts";
import type { StackRuntime } from "../public/Runtime.ts";

/** Logical artifact descriptors. Download/image resolution belongs to preparation. */
export interface NativeArtifact {
  readonly kind: "native";
  readonly service: string;
  readonly release: string;
}

export interface ContainerArtifact {
  readonly kind: "container";
  readonly service: string;
  readonly image: string;
}

export interface WorkloadSpec {
  readonly name: string;
  readonly capability: CapabilityName;
  readonly dependencies: ReadonlyArray<string>;
  readonly readiness: Readonly<{ readonly mode: "http" | "tcp"; readonly portField?: string }>;
  readonly restart: Readonly<{ readonly maxAttempts: number; readonly backoffMs: number }>;
  readonly artifacts: Readonly<{
    readonly native: NativeArtifact;
    readonly container: ContainerArtifact;
  }>;
}

export interface CapabilityModule<Settings> {
  readonly name: CapabilityName;
  readonly settings: Schema.Schema<Settings>;
  readonly defaultSettings: Settings;
  readonly defaultEnabled: boolean;
  readonly defaultActivation: ActivationMode;
  readonly dependencies: ReadonlyArray<CapabilityName>;
  readonly workloads: ReadonlyArray<WorkloadSpec>;
  readonly routes: ReadonlyArray<
    Readonly<{ readonly listener: string; readonly protocol: "http" | "tcp" }>
  >;
  readonly materialize: (settings: Settings, projectRoot: string) => Settings;
  readonly runtimeArtifact: (
    workload: WorkloadSpec,
    runtime: StackRuntime,
  ) => NativeArtifact | ContainerArtifact;
}

export const nativeArtifact = (service: string, release: string): NativeArtifact => ({
  kind: "native",
  service,
  release,
});

export const containerArtifact = (service: string, image: string): ContainerArtifact => ({
  kind: "container",
  service,
  image,
});

export const workload = (
  name: string,
  capability: CapabilityName,
  release: string,
  image: string,
  options: {
    readonly dependencies?: ReadonlyArray<string>;
    readonly readiness?: WorkloadSpec["readiness"];
    readonly restart?: WorkloadSpec["restart"];
  } = {},
): WorkloadSpec => ({
  name,
  capability,
  dependencies: options.dependencies ?? [],
  readiness: options.readiness ?? { mode: "tcp" },
  restart: options.restart ?? { maxAttempts: 5, backoffMs: 250 },
  artifacts: {
    native: nativeArtifact(name, release),
    container: containerArtifact(name, image),
  },
});

export const identityMaterialize = <T>(settings: T): T => settings;
