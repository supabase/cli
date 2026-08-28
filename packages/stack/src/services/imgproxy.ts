import type { ServiceDef } from "@supabase/process-compose";
import { dockerNetworkArgs } from "../Platform.ts";
import type { StackIdentity } from "../StackIdentity.ts";
import {
  dockerRunService,
  hostHttpHealthCheck,
  nativeRunService,
  type ContainerRuntimeOptions,
  type ServiceDependency,
} from "./service-utils.ts";
import { stackHealthBudgets } from "./health-budgets.ts";

interface ImgproxyServiceOptions {
  readonly port: number;
  /** Storage's caller-owned root, exposed to imgproxy through local:// URLs. */
  readonly dataDir: string;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

export interface NativeImgproxyOptions extends ImgproxyServiceOptions {
  readonly binPath: string;
}

interface DockerImgproxyOptions extends ImgproxyServiceOptions, ContainerRuntimeOptions {
  readonly image: string;
  readonly identity: StackIdentity;
  readonly platformOs: string;
}

const IMGPROXY_STORAGE_DIR = "/var/lib/storage";

const imgproxyHealthCheck = (port: number): ServiceDef["healthCheck"] =>
  hostHttpHealthCheck(port, "/health", {
    ...stackHealthBudgets.imgproxy,
  });

const imgproxyEnv = (port: number, host: "127.0.0.1" | "") => ({
  IMGPROXY_BIND: `${host}:${port}`,
  // Storage emits absolute local:/// URLs. Keeping the root at / makes those
  // URLs addressable on the host while the data directory remains owned by
  // Storage and is not treated as imgproxy's independent state.
  IMGPROXY_LOCAL_FILESYSTEM_ROOT: "/",
  IMGPROXY_USE_ETAG: "/",
  IMGPROXY_MAX_SRC_RESOLUTION: "50",
  IMGPROXY_MAX_SRC_FILE_SIZE: "25000000",
  IMGPROXY_MAX_ANIMATION_FRAMES: "60",
  IMGPROXY_ENABLE_WEBP_DETECTION: "true",
  IMGPROXY_PRESETS: "default=width:3000/height:8192",
  IMGPROXY_FORMAT_QUALITY: "jpeg=80,avif=62,webp=80",
});

export const makeImgproxyServiceNative = (opts: NativeImgproxyOptions): ServiceDef =>
  nativeRunService({
    name: "imgproxy",
    command: `${opts.binPath}/bin/imgproxy`,
    env: imgproxyEnv(opts.port, "127.0.0.1"),
    dependencies: opts.dependencies,
    healthCheck: imgproxyHealthCheck(opts.port),
  });

export const makeImgproxyServiceDocker = (opts: DockerImgproxyOptions): ServiceDef =>
  dockerRunService({
    runtime: opts.runtime,
    name: "imgproxy",
    identity: opts.identity,
    image: opts.image,
    networkArgs: dockerNetworkArgs(opts.platformOs, [opts.port]),
    volumes: [`${opts.dataDir}:${IMGPROXY_STORAGE_DIR}`],
    env: imgproxyEnv(opts.port, ""),
    dependencies: opts.dependencies,
    healthCheck: imgproxyHealthCheck(opts.port),
  });
