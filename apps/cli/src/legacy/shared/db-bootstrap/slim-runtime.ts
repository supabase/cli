/**
 * Slim-image runtime contracts that differ from docker.io. Spec builders switch
 * on {@link usesSlimImageRuntime} so flag-off stays byte-identical even if a
 * caller passes a ghcr-shaped override.
 *
 * Docker CLI `--health-cmd` is always stored as `CMD-SHELL` and executed with
 * `/bin/sh -c` (`docker-create-args.ts`). Distroless images with no `/bin/sh`
 * (auth, storage, studio, pg-meta, edge-runtime) therefore cannot carry a
 * Docker healthcheck through this CLI — omit it and let
 * `legacyCheckContainerReady` treat `Running` as ready, the same as PostgREST.
 * Elixir/busybox images (realtime, analytics) and Vector do ship `/bin/sh` plus
 * a wget applet, so they keep an exec-form probe that the CLI quotes into
 * CMD-SHELL.
 */

import { usesSlimImageRuntime } from "../../../shared/services/slim-images.ts";

/** {@link usesSlimImageRuntime} under the mandatory `legacy` export prefix. */
export function legacyUsesSlimRuntime(image: string): boolean {
  return usesSlimImageRuntime(image);
}

export const LEGACY_SLIM_BUSYBOX = "/bin/busybox";

export function legacySlimBusyboxWgetHealthcheck(
  url: string,
  opts: { readonly header?: string; readonly startPeriodSeconds?: number } = {},
): {
  readonly test: ReadonlyArray<string>;
  readonly intervalSeconds: number;
  readonly timeoutSeconds: number;
  readonly retries: number;
  readonly startPeriodSeconds?: number;
} {
  const test = ["CMD", LEGACY_SLIM_BUSYBOX, "wget", "-q", "--spider"];
  if (opts.header !== undefined) {
    test.push("--header", opts.header);
  }
  test.push(url);
  return {
    test,
    intervalSeconds: 10,
    timeoutSeconds: 2,
    retries: 3,
    ...(opts.startPeriodSeconds === undefined ? {} : { startPeriodSeconds: opts.startPeriodSeconds }),
  };
}
