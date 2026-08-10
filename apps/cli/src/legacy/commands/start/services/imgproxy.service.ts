/**
 * Port of Go's "Start Storage ImgProxy" block
 * (`apps/cli-go/internal/start/start.go:1059-1099`).
 *
 * Enabled gate: `isStorageEnabled && isImgProxyEnabled` (`start.go:1060`) —
 * i.e. `config.storage.enabled && config.storage.image_transformation?.enabled
 * && !isContainerExcluded(imgproxyImage, excluded)`, AND Storage itself must
 * be enabled (ImgProxy mounts Storage's own volumes via `VolumesFrom` below,
 * so it cannot meaningfully run without it). Gating the actual container
 * start is the future `start.handler.ts` orchestrator's responsibility —
 * see `start.services.ts`'s `imgproxy` catalog entry (`enabledGate:
 * "storage.enabled && storage.image_transformation.enabled"`, `dependsOn:
 * ["storage"]`) — this module only builds the container spec once called.
 * The caller must pass the SAME `isImgProxyEnabled` boolean it used for this
 * gating decision into `storage.service.ts`'s `LegacyStorageEnvInput.
 * imageTransformationEnabled` — see that file's header.
 */

import { legacyServiceContainerName } from "../../../shared/legacy-docker-ids.ts";
import type { LegacyStartContainerSpec } from "../../../shared/db-bootstrap/docker-create-args.ts";

/**
 * Go's `Env` literal (`start.go:1065-1075`) — entirely static, no
 * `config.toml` field feeds any of these values.
 */
export function legacyBuildImgproxyEnv(): Record<string, string> {
  return {
    IMGPROXY_BIND: ":5001",
    IMGPROXY_LOCAL_FILESYSTEM_ROOT: "/",
    // Reproduced verbatim: Go's own literal is `"/"`, not a boolean-looking
    // value (`start.go:1068`) — not "fixed" here, matching Go exactly.
    IMGPROXY_USE_ETAG: "/",
    IMGPROXY_MAX_SRC_RESOLUTION: "50",
    IMGPROXY_MAX_SRC_FILE_SIZE: "25000000",
    IMGPROXY_MAX_ANIMATION_FRAMES: "60",
    IMGPROXY_ENABLE_WEBP_DETECTION: "true",
    IMGPROXY_PRESETS: "default=width:3000/height:8192",
    IMGPROXY_FORMAT_QUALITY: "jpeg=80,avif=62,webp=80",
  };
}

export interface LegacyImgproxyContainerSpecInput {
  /** Go's `Config.ProjectId`, already sanitized — see `legacyServiceContainerName`'s callers. */
  readonly projectId: string;
  /** `container.HostConfig.NetworkMode`/`network.NetworkingConfig` target — the `--network-id` override or `utils.NetId`. */
  readonly networkId: string;
  /** `utils.Config.Storage.ImgProxyImage`, already resolved/pulled by the caller (`image-prepull.ts`). */
  readonly image: string;
}

/**
 * Builds the `docker create` spec for the ImgProxy container
 * (`start.go:1059-1099`). `volumesFrom` mounts Storage's own volumes
 * (`container.HostConfig.VolumesFrom: []string{utils.StorageId}`,
 * `start.go:1084`) — no `ports`/`exposedPorts`; ImgProxy is reached only via
 * its Docker network alias, from Storage's own `IMGPROXY_URL` env var
 * (`storage.service.ts`'s `legacyBuildStorageEnv`).
 */
export function legacyBuildImgproxyContainerSpec(
  input: LegacyImgproxyContainerSpecInput,
): LegacyStartContainerSpec {
  return {
    image: input.image,
    containerName: legacyServiceContainerName("imgproxy", input.projectId),
    env: legacyBuildImgproxyEnv(),
    binds: [],
    volumesFrom: [legacyServiceContainerName("storage", input.projectId)],
    healthcheck: {
      test: ["CMD", "imgproxy", "health"],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
    },
    restartPolicy: "unless-stopped",
    networkId: input.networkId,
    // `utils.ImgProxyAliases = []string{"imgproxy"}` (`utils/config.go:43`).
    networkAliases: ["imgproxy"],
    labels: {},
  };
}
