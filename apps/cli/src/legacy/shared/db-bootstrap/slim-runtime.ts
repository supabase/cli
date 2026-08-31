/**
 * Slim-image runtime contracts that still differ from docker.io. Spec builders
 * switch on {@link usesSlimImageRuntime} so flag-off stays byte-identical even
 * if a caller passes a ghcr-shaped override.
 *
 * Slim auth, storage, Vector, and the Elixir images (realtime, analytics,
 * pooler) ship BusyBox wget — not GNU wget and not curl. BusyBox documents
 * `-q`/`--quiet`, `--spider`, `--header`, and `-T`; it does not document
 * GNU `--no-verbose` or `--tries`. Studio, pg-meta, Postgres, and
 * edge-runtime share the docker.io probes (`node` / `pg_isready`).
 */

import { usesSlimImageRuntime } from "../../../shared/services/slim-images.ts";

/** {@link usesSlimImageRuntime} under the mandatory `legacy` export prefix. */
export function legacyUsesSlimRuntime(image: string): boolean {
  return usesSlimImageRuntime(image);
}

/**
 * In-container HTTP probe for slim images. `-q --spider` is the intersection
 * of BusyBox wget (what slim actually ships) and GNU wget (docker.io leftovers).
 */
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
  const test = ["CMD", "wget", "-q", "--spider"];
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

/** BusyBox-safe wait used by Vector's entrypoint until Logflare answers. */
export function legacySlimWgetWaitCommand(url: string): string {
  return `wget -q -T 2 --spider ${url}`;
}
