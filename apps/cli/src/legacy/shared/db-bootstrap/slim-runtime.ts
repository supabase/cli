/**
 * Slim-image runtime contracts that still differ from docker.io. Spec builders
 * switch on {@link usesSlimImageRuntime} so flag-off stays byte-identical even
 * if a caller passes a ghcr-shaped override.
 *
 * Auth, studio, pg-meta, Vector, Postgres, storage, and edge-runtime share the
 * docker.io specs (`sh`/`wget`/`node`). Elixir images (realtime, analytics,
 * pooler) ship busybox `wget` on PATH but not `curl`, so they keep a wget
 * probe instead of docker.io's `curl --head`. Slim analytics also keeps the
 * image entrypoint (`/app/bin/logflare`, not docker.io's `./logflare`).
 */

import { usesSlimImageRuntime } from "../../../shared/services/slim-images.ts";

/** {@link usesSlimImageRuntime} under the mandatory `legacy` export prefix. */
export function legacyUsesSlimRuntime(image: string): boolean {
  return usesSlimImageRuntime(image);
}

export function legacySlimWgetHealthcheck(
  url: string,
  opts: { readonly header?: string; readonly startPeriodSeconds?: number } = {},
): {
  readonly test: ReadonlyArray<string>;
  readonly intervalSeconds: number;
  readonly timeoutSeconds: number;
  readonly retries: number;
  readonly startPeriodSeconds?: number;
} {
  const test = ["CMD", "wget", "--no-verbose", "--tries=1", "--spider"];
  if (opts.header !== undefined) {
    test.push("--header", opts.header);
  }
  test.push(url);
  return {
    test,
    intervalSeconds: 10,
    timeoutSeconds: 2,
    retries: 3,
    ...(opts.startPeriodSeconds === undefined
      ? {}
      : { startPeriodSeconds: opts.startPeriodSeconds }),
  };
}
