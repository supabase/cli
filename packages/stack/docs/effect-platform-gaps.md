# Effect V4 Platform API Gaps — Supabase CLI Audit

After moving `packages/cli` behind a local platform boundary, the remaining upstream gaps are narrower than they first appeared.

## Already Covered by Effect Platform

These are available today and do not need local stopgaps beyond normal wiring:

- `Stdio` and `Terminal` cover argv and interactive stdio access.
- `Config` and `ConfigProvider.fromEnv` cover environment variable injection.
- `effect/unstable/process` covers child-process spawning for normal subprocess use.
- `effect/unstable/socket/SocketServer` covers raw TCP server binding, including bind-to-port-0 flows.

The old “raw TCP server for port probing” gap is no longer current.

## 1. No Current Process Service

**Current CLI use cases**

- subscribe to `SIGINT` / `SIGTERM`
- react to stdin shutdown for foreground cleanup
- set `process.exitCode`
- call `process.exit(code)`

**Why this still matters**

Effect has process spawning, but not a reusable abstraction for the currently running process. Signal handling and exit behavior still require direct runtime access.

**Suggested API**

```ts
const currentProcess = yield* CurrentProcess.CurrentProcess;

yield* currentProcess.awaitSignal(["SIGINT", "SIGTERM"]);
yield* currentProcess.setExitCode(1);
yield* currentProcess.exit(1);
```

Useful extras:

- `signals: Stream<Signal>`
- `stdinClosed: Effect<void>`
- `pid: Effect<number>`

## 2. No Runtime Info Service

**Current CLI use cases**

- `platform`
- `arch`
- `homedir`
- `execPath`
- `pid`

We also still have stack-level use cases elsewhere for values like `hostname` and `userInfo`.

**Why this still matters**

These values are stable runtime facts, but today they come from `node:process` / `node:os` instead of an injectable service.

**Suggested API**

```ts
const runtime = yield* RuntimeInfo.RuntimeInfo;

const platform = runtime.platform;
const arch = runtime.arch;
const homeDir = runtime.homeDir;
const execPath = runtime.execPath;
const pid = runtime.pid;
```

Possible expansion:

- `hostname`
- `userInfo`
- `tmpdir`

## 3. No TTY Metadata Service

**Current CLI use cases**

- `stdin.isTTY`
- `stdout.isTTY`

**Why this still matters**

Effect exposes stdio streams and terminal operations, but not simple injectable TTY capability metadata. CLI code often needs this before deciding whether prompts or rich output are allowed.

**Suggested API**

```ts
const tty = yield* Tty.Tty;

if (tty.stdoutIsTty) {
  // interactive formatter
}
```

## 4. No DI-Safe Current Working Directory

**Current CLI use cases**

- resolve the current project root
- connect the local stack to the caller's working directory

**Why this still matters**

`cwd` is runtime state that affects behavior and tests. We can wrap it locally, but Effect does not currently expose a first-class service for it. Relying on implicit `process.cwd()` keeps project resolution outside the platform abstraction.

**Suggested API**

```ts
const workingDirectory = yield* WorkingDirectory.WorkingDirectory;
const cwd = workingDirectory.current;
```

## 5. ChildProcess IPC Is Still Missing

**Current stack use case**

We still have daemon-style parent/child coordination that needs a structured message channel, not just stdio pipes.

**What Effect provides today**

`ChildProcessSpawner` and `ChildProcess.make` with normal stdio and FD support.

**What is still missing**

- `fork()`-style IPC channel
- message send/receive primitives
- ergonomic `unref()` support for daemon lifecycles

## 6. No Crypto Primitives Service

**Current stack use cases**

- SHA-256 checksums
- HMAC signing
- token decryption

**Why this still matters**

Effect has randomness and encodings, but not a platform crypto service for hashing, MACs, or encryption/decryption.

## 7. No Sync URL-to-Path Utility for Module-Level Use

**Current stack use case**

Module-level resolution of daemon entrypoints from `import.meta.url`.

**Why this still matters**

`Path.fromFileUrl` is effectful, which is appropriate in-context, but some entrypoint constants need a synchronous conversion at module scope.
