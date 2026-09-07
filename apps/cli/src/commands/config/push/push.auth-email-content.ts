/**
 * `config push` reads HTML from `content_path` before building the auth push
 * body. Both templates and notifications resolve relative paths from the
 * project root (parent of `supabase/`); notifications additionally fall back
 * to the legacy `supabase/`-relative location when the root-resolved file is
 * missing, so configs written for older scaffolds keep working. Every
 * resolved path — relative or absolute — is confined to the project root
 * before it is read, since the loaded bytes are uploaded to whichever
 * project the config names.
 */

import type { CliConfig } from "@supabase/config";
import { legacyResolveNotificationContentPath } from "../../../command-internal/legacy-config-validate.ts";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

type AuthEmail = CliConfig["auth"]["email"];

/**
 * HTML bodies loaded from `content_path` for auth email templates and
 * notifications. Keys are template/notification names (e.g. `invite`,
 * `password_changed`); values are the raw file contents.
 */
export interface LegacyAuthEmailContent {
  readonly template: Readonly<Record<string, string>>;
  readonly notification: Readonly<Record<string, string>>;
}

const EMPTY_AUTH_EMAIL_CONTENT: LegacyAuthEmailContent = {
  template: {},
  notification: {},
};

/**
 * Whether `candidatePath` resolves inside (or exactly to) `root`. Both
 * arguments must already be normalized absolute paths (see `resolve`/
 * `realpathSync`). Only rejects a genuine `..` traversal — a same-level
 * sibling whose name happens to start with two dots (e.g. `..templates`)
 * is a distinct, in-root path and must not be rejected.
 */
function isPathContainedInRoot(root: string, candidatePath: string): boolean {
  const rel = relative(root, candidatePath);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * Resolves `path` to its real, symlink-free location for the containment
 * check, falling back to lexical normalization when the target doesn't
 * exist yet — that case has no symlink to dereference, and is left for
 * `readTemplateContent` to report as a normal missing-file error.
 */
function realOrLexicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Resolves a template/notification `content_path`, rejecting any result
 * that escapes the project root — a relative `..` traversal, or an absolute
 * or symlinked path pointing elsewhere on disk. Rejecting here means an
 * out-of-root path is never read, since the caller only reads a path this
 * function returns. Symlinks are dereferenced (`realpathSync`) before the
 * containment check, since `readFileSync` would otherwise follow an
 * in-root symlink straight to an out-of-root target.
 *
 * @param kind - `template` or `notification` (used in the error prefix and to
 *   select the notification-only legacy `supabase/`-relative fallback).
 * @param name - Config key (e.g. `invite`, `password_changed`).
 * @param cwd - Discovered project root (parent of `supabase/`).
 * @param contentPath - Raw `content_path` value from the config.
 * @returns Absolute, symlink-resolved path, confined to `cwd`.
 * @throws When the resolved path falls outside the project root.
 */
function resolveContainedContentPath(
  kind: "template" | "notification",
  name: string,
  cwd: string,
  contentPath: string,
): string {
  const candidate =
    kind === "notification"
      ? legacyResolveNotificationContentPath(cwd, contentPath)
      : isAbsolute(contentPath)
        ? contentPath
        : join(cwd, contentPath);
  const root = realpathSync(cwd);
  const resolved = realOrLexicalPath(candidate);
  if (!isPathContainedInRoot(root, resolved)) {
    throw new Error(
      `Invalid config for auth.email.${kind}.${name}.content_path: resolves outside the project root (${resolved})`,
    );
  }
  return resolved;
}

/**
 * Reads a template HTML file, wrapping a filesystem error with an
 * `Invalid config for auth.email.<kind>.<name>.content_path: <cause>`
 * message — the CLI's established config-validation error shape.
 *
 * @param kind - `template` or `notification` (used in the error prefix).
 * @param name - Config key (e.g. `invite`, `password_changed`).
 * @param resolvedPath - Absolute path to the template HTML.
 * @returns File contents as UTF-8 text.
 * @throws When the file cannot be read.
 */
function readTemplateContent(
  kind: "template" | "notification",
  name: string,
  resolvedPath: string,
): string {
  try {
    return readFileSync(resolvedPath, "utf8");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Invalid config for auth.email.${kind}.${name}.content_path: ${message}`);
  }
}

/**
 * Loads auth email template HTML from disk for `config push`.
 *
 * Templates and notifications resolve `content_path` from the project root;
 * notifications are only read when `enabled = true`.
 *
 * @param cwd - Discovered project root (parent of `supabase/`).
 * @param email - Decoded `config.auth.email` from `@supabase/config`.
 * @returns Loaded HTML keyed by template/notification name. Empty records when
 *   nothing was configured or all `content_path` values were empty.
 * @throws When a configured `content_path` points to a missing or unreadable file.
 */
export function legacyLoadAuthEmailContent(cwd: string, email: AuthEmail): LegacyAuthEmailContent {
  const template: Record<string, string> = {};
  const notification: Record<string, string> = {};

  for (const [name, tmpl] of Object.entries(email.template)) {
    const contentPath = tmpl.content_path ?? "";
    if (contentPath.length === 0) {
      continue;
    }
    const resolved = resolveContainedContentPath("template", name, cwd, contentPath);
    template[name] = readTemplateContent("template", name, resolved);
  }

  for (const [name, notif] of Object.entries(email.notification)) {
    if (!notif.enabled) {
      continue;
    }
    const contentPath = notif.content_path ?? "";
    if (contentPath.length === 0) {
      continue;
    }
    const resolved = resolveContainedContentPath("notification", name, cwd, contentPath);
    notification[name] = readTemplateContent("notification", name, resolved);
  }

  if (Object.keys(template).length === 0 && Object.keys(notification).length === 0) {
    return EMPTY_AUTH_EMAIL_CONTENT;
  }

  return { template, notification };
}
