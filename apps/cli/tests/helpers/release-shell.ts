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

export async function verifyExpectedShell(binPath: string): Promise<ShellCheckResult> {
  const result = await runCli(binPath, ["init", "--help"]);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const passed = result.exitCode === 0 && output.includes("init");
  return {
    passed,
    detail: passed
      ? 'dispatch ok: "init --help" succeeded'
      : `expected dispatch via "init --help", got exit=${result.exitCode}, stdout="${result.stdout}", stderr="${result.stderr}"`,
  };
}
