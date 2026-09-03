/**
 * Statically-dispatched oxfmt native binding for TypeScript typegen output.
 *
 * `@supabase/postgrest-typegen`'s default formatter goes through the `oxfmt`
 * JS package, whose ESM dist resolves its platform binding at runtime via
 * `createRequire(import.meta.url)` — a dynamic path `bun build --compile`
 * cannot follow, so the compiled binary would fail to find the `.node` addon
 * (and the same dist lazily imports optional prettier plugins that are not
 * installed at all). Instead, mirror the `@parcel/watcher` pattern
 * (`shared/runtime/parcel-file-watcher.layer.ts`): one static `require` per
 * shipped CLI target, so Bun embeds exactly the right `.node` binding, and
 * inject the resulting formatter through the generator's `format` option.
 *
 * Source-run ESM has no `require` binding (`ReferenceError`); compiled Bun
 * injects one that loads embedded `.node` addons. `createRequire` is only
 * the source-run fallback — using it in the compiled binary resolves from
 * `/$bunfs/root` and misses those addons. Per-platform `require("…")`
 * literals stay so `bun build --compile` still embeds them.
 *
 * The binding version in `package.json` must stay in lockstep with the
 * `oxfmt` version pinned by `@supabase/postgrest-typegen`, and the format
 * options below must mirror the package's own `defaultFormat` so injected and
 * default output stay identical.
 */

import { createRequire } from "node:module";

declare const SUPABASE_LIBC: string | undefined;

/**
 * Callback the binding invokes to format embedded languages (CSS-in-JS
 * template literals and similar). Generated type declarations contain no
 * template literals, so these can never fire for typegen output.
 */
type LegacyOxfmtEmbedCallback = (options: unknown, code: unknown) => never;

interface LegacyOxfmtBinding {
  readonly format: (
    fileName: string,
    sourceText: string,
    options: Readonly<Record<string, unknown>>,
    formatFileCallback: LegacyOxfmtEmbedCallback,
    formatEmbeddedCodeCallback: LegacyOxfmtEmbedCallback,
    formatEmbeddedDocCallback: LegacyOxfmtEmbedCallback,
  ) => Promise<{
    readonly code: string;
    readonly errors: ReadonlyArray<{ readonly message: string }>;
  }>;
}

const sourceRequire = createRequire(import.meta.url);

function loadOxfmtBinding(
  loadCompiled: () => LegacyOxfmtBinding,
  specifier: string,
): LegacyOxfmtBinding {
  try {
    return loadCompiled();
  } catch (error) {
    if (error instanceof ReferenceError) {
      return sourceRequire(specifier);
    }
    throw error;
  }
}

function legacyRequireOxfmtBinding(): LegacyOxfmtBinding {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") {
      return loadOxfmtBinding(
        () => require("@oxfmt/binding-darwin-arm64"),
        "@oxfmt/binding-darwin-arm64",
      );
    }
    if (process.arch === "x64") {
      return loadOxfmtBinding(
        () => require("@oxfmt/binding-darwin-x64"),
        "@oxfmt/binding-darwin-x64",
      );
    }
  }

  if (process.platform === "linux") {
    if (process.arch === "arm64") {
      if (typeof SUPABASE_LIBC !== "undefined" && SUPABASE_LIBC === "musl") {
        return loadOxfmtBinding(
          () => require("@oxfmt/binding-linux-arm64-musl"),
          "@oxfmt/binding-linux-arm64-musl",
        );
      }
      return loadOxfmtBinding(
        () => require("@oxfmt/binding-linux-arm64-gnu"),
        "@oxfmt/binding-linux-arm64-gnu",
      );
    }
    if (process.arch === "x64") {
      if (typeof SUPABASE_LIBC !== "undefined" && SUPABASE_LIBC === "musl") {
        return loadOxfmtBinding(
          () => require("@oxfmt/binding-linux-x64-musl"),
          "@oxfmt/binding-linux-x64-musl",
        );
      }
      return loadOxfmtBinding(
        () => require("@oxfmt/binding-linux-x64-gnu"),
        "@oxfmt/binding-linux-x64-gnu",
      );
    }
  }

  if (process.platform === "win32") {
    if (process.arch === "arm64") {
      return loadOxfmtBinding(
        () => require("@oxfmt/binding-win32-arm64-msvc"),
        "@oxfmt/binding-win32-arm64-msvc",
      );
    }
    if (process.arch === "x64") {
      return loadOxfmtBinding(
        () => require("@oxfmt/binding-win32-x64-msvc"),
        "@oxfmt/binding-win32-x64-msvc",
      );
    }
  }

  throw new Error(`Unsupported oxfmt platform: ${process.platform}-${process.arch}`);
}

const rejectEmbedded: LegacyOxfmtEmbedCallback = () => {
  throw new Error("embedded-language formatting is not available for generated types");
};

/**
 * Drop-in for `GenerateTypescriptOptions.format`, byte-equivalent to the
 * typegen package's own oxfmt default (same virtual file name, same
 * `semi`/`printWidth` options, same error surfacing).
 */
export async function legacyOxfmtTypegenFormat(code: string): Promise<string> {
  const binding = legacyRequireOxfmtBinding();
  const { code: formatted, errors } = await binding.format(
    "output.ts",
    code,
    { semi: false, printWidth: 80 },
    rejectEmbedded,
    rejectEmbedded,
    rejectEmbedded,
  );
  if (errors.length > 0) {
    throw new Error(
      `oxfmt failed to format generated TypeScript output: ${errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
  return formatted;
}
