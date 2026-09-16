/**
 * Statically-dispatched oxfmt native binding used to format generated TypeScript.
 *
 * `@supabase/postgrest-typegen` formats through the `oxfmt` JS package, whose ESM dist
 * resolves its platform binding via `createRequire(import.meta.url)` — a dynamic path
 * `bun build --compile` cannot follow, leaving the compiled binary unable to find the `.node`
 * addon. One static `require` per shipped target makes Bun embed the right binding, which is
 * then injected through the generator's `format` option.
 */

import { createRequire } from "node:module";

declare const SUPABASE_LIBC: string | undefined;

/**
 * Callback the binding invokes for embedded languages. Generated type declarations contain no
 * template literals, so it can never fire.
 */
type OxfmtEmbedCallback = (options: unknown, code: unknown) => never;

interface OxfmtBinding {
  readonly format: (
    fileName: string,
    sourceText: string,
    options: Readonly<Record<string, unknown>>,
    formatFileCallback: OxfmtEmbedCallback,
    formatEmbeddedCodeCallback: OxfmtEmbedCallback,
    formatEmbeddedDocCallback: OxfmtEmbedCallback,
  ) => Promise<{
    readonly code: string;
    readonly errors: ReadonlyArray<{ readonly message: string }>;
  }>;
}

const sourceRequire = createRequire(import.meta.url);

/**
 * Source-run ESM has no `require` binding and throws `ReferenceError`; compiled Bun injects one
 * that loads embedded `.node` addons. `createRequire` is the source-run fallback only — in the
 * compiled binary it resolves from `/$bunfs/root` and misses those addons.
 */
function loadOxfmtBinding(loadCompiled: () => OxfmtBinding, specifier: string): OxfmtBinding {
  try {
    return loadCompiled();
  } catch (error) {
    if (error instanceof ReferenceError) {
      return sourceRequire(specifier);
    }
    throw error;
  }
}

/**
 * `process.report` omits `glibcVersionRuntime` on musl libc; the dev binary build
 * (`scripts/build-binary.ts`) and source runs never set the `SUPABASE_LIBC` build define, so
 * this is the only signal available to them.
 */
function isRunningOnMusl(): boolean {
  try {
    const report: unknown = process.report?.getReport();
    if (typeof report !== "object" || report === null || !("header" in report)) return false;
    const header = report.header;
    if (typeof header !== "object" || header === null) return false;
    return !("glibcVersionRuntime" in header) || header.glibcVersionRuntime === undefined;
  } catch {
    return false;
  }
}

function requireOxfmtBinding(): OxfmtBinding {
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
    const useMusl =
      typeof SUPABASE_LIBC !== "undefined" ? SUPABASE_LIBC === "musl" : isRunningOnMusl();
    if (process.arch === "arm64") {
      if (useMusl) {
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
      if (useMusl) {
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

const rejectEmbedded: OxfmtEmbedCallback = () => {
  throw new Error("embedded-language formatting is not available for generated types");
};

/**
 * Drop-in for `GenerateTypescriptOptions.format`, byte-equivalent to the typegen package's own
 * oxfmt default. The binding version in `package.json` must track the `oxfmt` version pinned by
 * `@supabase/postgrest-typegen`, and these options must mirror its `defaultFormat`.
 */
export async function oxfmtTypegenFormat(code: string): Promise<string> {
  const binding = requireOxfmtBinding();
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
