import type { ServiceDef } from "@supabase/process-compose";
import { dockerRunService, hostHttpHealthCheck, type ServiceDependency } from "./service-utils.ts";

interface DockerImgproxyOptions {
  readonly image: string;
  readonly port: number;
  readonly apiPort: number;
  readonly dataDir: string;
  readonly networkArgs: ReadonlyArray<string>;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

const IMGPROXY_STORAGE_DIR = "/var/lib/storage";

const imgproxyHealthCheck = (port: number): ServiceDef["healthCheck"] =>
  hostHttpHealthCheck(port, "/health", {
    initialDelaySeconds: 1,
    periodSeconds: 0.5,
    failureThreshold: 30,
  });

export const makeImgproxyServiceDocker = (opts: DockerImgproxyOptions): ServiceDef =>
  dockerRunService({
    name: "imgproxy",
    containerName: `supabase-imgproxy-${opts.apiPort}`,
    image: opts.image,
    networkArgs: opts.networkArgs,
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
    dependsOn: opts.dependencies,
    healthCheck: imgproxyHealthCheck(opts.port),
  });
