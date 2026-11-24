import { Console, Effect } from "effect";
import { readComputeStacks } from "../src/shared/compute/compute-stacks.macro.ts";
import { compileOptions, localBuildDefine } from "./compile-options.ts";

/**
 * Compiles the CLI to machine code with Bun's AOT compiler into `dist-aot/supabase`, run via
 * `bunx bun@canary run build:aot` until a stable Bun ships AOT compilation.
 */
if (!Bun.semver.satisfies(Bun.version, ">=1.4.6")) {
  // Older Bun ignores the AOT options and would silently emit a bytecode binary.
  throw new Error(`AOT compilation needs Bun 1.4.6 or later; running ${Bun.version}`);
}

/**
 * AOT disables Bun macros, so the compute starter files the `compute-stacks.ts` macro inlines are
 * read here and inlined by the build instead.
 */
const inlineComputeStacks: Bun.BunPlugin = {
  name: "inline-compute-stacks",
  setup(build) {
    build.onLoad({ filter: /\/shared\/compute\/compute-stacks\.ts$/ }, () =>
      readComputeStacks().then((stacks) => ({
        loader: "js",
        contents: `export const COMPUTE_STACKS = ${JSON.stringify(stacks)};`,
      })),
    );
  },
};

const compile = {
  outfile: "dist-aot/supabase",
  aot: true,
  // `fn.toString()` returns `[native code]`; nothing in the CLI reads function sources.
  functionSource: false,
  // Automatic trimming keeps every feature because dependencies index `globalThis` with computed
  // names, so the features the CLI never uses are listed instead.
  trim: {
    locales: ["en"],
    remove: [
      "jit",
      "aot",
      "check",
      "run",
      "lint",
      "install",
      "fmt",
      "test",
      "bundler",
      "repl",
      "create",
      "upgrade",
      "s3",
      "redis",
      "sql",
      "webview",
      "image",
      "html-rewriter",
      "markdown",
      "cron",
      "csrf",
      "password",
      "secrets",
      "shell",
      "fs-router",
      "dialogs",
      "terminal",
      "ffi",
      "semver",
      "http3",
      "udp",
      "profiler",
      "inspector",
      "plugin",
      "diff",
      "jsonl",
      "json5",
      "xml",
      "process-report",
    ],
  },
};

const {
  bytecode: _bytecode,
  bytecodeDepth: _bytecodeDepth,
  format: _format,
  ...aotOptions
} = compileOptions;

const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  compile,
  ...aotOptions,
  plugins: [inlineComputeStacks],
  define: await localBuildDefine(),
});
for (const log of result.logs) {
  Effect.runSync(Console.warn(log));
}
