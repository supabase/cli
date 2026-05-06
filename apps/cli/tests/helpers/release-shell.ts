type ReleaseTag = "latest" | "alpha" | "beta";

type ShellCheckResult = {
  readonly passed: boolean;
  readonly detail: string;
};

async function runCli(binPath: string, args: Array<string>) {
  const proc = Bun.spawn([binPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
  };
}

export async function verifyExpectedShell(
  binPath: string,
  tag: ReleaseTag,
): Promise<ShellCheckResult> {
  if (tag === "latest" || tag === "beta") {
    const result = await runCli(binPath, ["hello"]);
    const passed = result.exitCode === 0 && result.stdout === "hello legacy";
    return {
      passed,
      detail: passed
        ? `legacy sentinel: ${result.stdout}`
        : `expected legacy shell via "hello", got exit=${result.exitCode}, stdout="${result.stdout}", stderr="${result.stderr}"`,
    };
  }

  const result = await runCli(binPath, ["status", "--help"]);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const passed = result.exitCode === 0 && output.includes("status");
  return {
    passed,
    detail: passed
      ? 'next sentinel: "status --help" succeeded'
      : `expected next shell via "status --help", got exit=${result.exitCode}, stdout="${result.stdout}", stderr="${result.stderr}"`,
  };
}
