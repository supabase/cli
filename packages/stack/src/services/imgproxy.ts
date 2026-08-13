import type { ServiceDef } from "@supabase/process-compose";
import { dockerNetworkArgs } from "../Platform.ts";
import type { StackIdentity } from "../StackIdentity.ts";
import { dockerRunService, hostHttpHealthCheck, type ServiceDependency } from "./service-utils.ts";
import { stackHealthBudgets } from "./health-budgets.ts";

interface DockerImgproxyOptions {
  readonly image: string;
  readonly port: number;
  readonly identity: StackIdentity;
  readonly dataDir: string;
  readonly platformOs: string;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

const IMGPROXY_STORAGE_DIR = "/var/lib/storage";

const imgproxyHealthCheck = (port: number): ServiceDef["healthCheck"] =>
  hostHttpHealthCheck(port, "/health", {
    ...stackHealthBudgets.imgproxy,
  });

export const makeImgproxyServiceDocker = (opts: DockerImgproxyOptions): ServiceDef =>
  dockerRunService({
    name: "imgproxy",
    identity: opts.identity,
    image: opts.image,
    networkArgs: dockerNetworkArgs(opts.platformOs, [opts.port]),
    volumes: [`${opts.dataDir}:${IMGPROXY_STORAGE_DIR}`],
    env: {
      IMGPROXY_BIND: `:${opts.port}`,
      IMGPROXY_LOCAL_FILESYSTEM_ROOT: "/",
      IMGPROXY_USE_ETAG: "/",
      IMGPROXY_MAX_SRC_RESOLUTION: "50",
      IMGPROXY_MAX_SRC_FILE_SIZE: "25000000",
      IMGPROXY_MAX_ANIMATION_FRAMES: "60",
      IMGPROXY_ENABLE_WEBP_DETECTION: "true",
      IMGPROXY_PRESETS: "default=width:3000/height:8192",
      IMGPROXY_FORMAT_QUALITY: "jpeg=80,avif=62,webp=80",
    },
    dependencies: opts.dependencies,
    healthCheck: imgproxyHealthCheck(opts.port),
  });
