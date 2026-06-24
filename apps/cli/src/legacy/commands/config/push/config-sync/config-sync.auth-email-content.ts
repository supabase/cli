/**
 * Port of Go `(*email).validate` file-loading from `apps/cli-go/pkg/config/config.go`
 * and path resolution from `(*baseConfig).resolve`.
 *
 * `config push` reads HTML from `content_path` before building the auth push
 * subset. Templates and notifications use different base directories:
 *   - `[auth.email.template.*]`     → relative to project root (parent of `supabase/`)
 *   - `[auth.email.notification.*]` → relative to `supabase/`
 */

import type { ProjectConfig } from "@supabase/config";
import { readFileSync } from "node:fs";
import { isAbsolute, dirname, join } from "node:path";

type AuthEmail = ProjectConfig["auth"]["email"];

/**
 * HTML bodies loaded from `content_path` for auth email templates and
 * notifications. Keys are template/notification names (e.g. `invite`,
 * `password_changed`); values are the raw file contents.
 */
export interface AuthEmailContent {
  readonly template: Readonly<Record<string, string>>;
  readonly notification: Readonly<Record<string, string>>;
}

const EMPTY_AUTH_EMAIL_CONTENT: AuthEmailContent = {
  template: {},
  notification: {},
};

/**
 * Derives project root and `supabase/` paths from a loaded config file path.
 *
 * Config lives at `<projectRoot>/supabase/config.{toml,json}` — the same rule
 * `loadProjectConfigFile` uses for env resolution.
 *
 * @param configPath - Absolute path returned by `loadProjectConfig` (`loaded.path`).
 */
export function projectDirsFromConfigPath(configPath: string): {
  readonly projectRoot: string;
  readonly supabaseDir: string;
} {
  const projectRoot = dirname(dirname(configPath));
  return { projectRoot, supabaseDir: join(projectRoot, "supabase") };
}

/**
 * Resolves a `content_path` to an absolute filesystem path.
 *
 * @param contentPath - Path from `config.toml` (absolute or relative to `baseDir`).
 * @param baseDir - Project root for templates, or `supabase/` for notifications.
 * @returns Absolute path, or `""` when `contentPath` is empty.
 */
function resolveContentPath(contentPath: string, baseDir: string): string {
  if (contentPath.length === 0) {
    return "";
  }
  return isAbsolute(contentPath) ? contentPath : join(baseDir, contentPath);
}

/**
 * Reads a template HTML file and wraps filesystem errors in Go-shaped messages.
 *
 * @param kind - `template` or `notification` (used in the error prefix).
 * @param name - Config key (e.g. `invite`, `password_changed`).
 * @param resolvedPath - Absolute path from {@link resolveContentPath}.
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
 * Mirrors Go `(*email).validate` + `(*baseConfig).resolve`: transactional
 * templates resolve `content_path` from the project root; notifications resolve
 * from `supabase/` and are only read when `enabled = true`.
 *
 * @param cwd - Discovered project root (parent of `supabase/`).
 * @param supabaseDir - Absolute path to the `supabase/` directory.
 * @param email - Decoded `config.auth.email` from `@supabase/config`.
 * @returns Loaded HTML keyed by template/notification name. Empty records when
 *   nothing was configured or all `content_path` values were empty.
 * @throws When a configured `content_path` points to a missing or unreadable file.
 */
export function loadAuthEmailContent(
  cwd: string,
  supabaseDir: string,
  email: AuthEmail,
): AuthEmailContent {
  const template: Record<string, string> = {};
  const notification: Record<string, string> = {};

  for (const [name, tmpl] of Object.entries(email.template)) {
    const contentPath = tmpl.content_path ?? "";
    if (contentPath.length === 0) {
      continue;
    }
    const resolved = resolveContentPath(contentPath, cwd);
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
    const resolved = resolveContentPath(contentPath, supabaseDir);
    notification[name] = readTemplateContent("notification", name, resolved);
  }

  if (Object.keys(template).length === 0 && Object.keys(notification).length === 0) {
    return EMPTY_AUTH_EMAIL_CONTENT;
  }

  return { template, notification };
}
