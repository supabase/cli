const HELP = `Usage: bun scripts/demo-inspect-realtime.ts [options]

  --url <url>           Project URL. Omit to let the command detect a target.
  --api-key <key>       Publishable/anon key. Omit to let the command resolve one.
  --channel <name>      Channel to demo on. (default demo-room)
  --table <schema.tbl>  Also demo database changes against this table.
                        The table must be in the supabase_realtime publication.
  --email <email>       Sign in, to demo RLS and private channels.
  --password <pw>       Password for --email.
  --cli <path>          CLI to drive. (default: the built binary, else the source)
  --help
`;

interface Options {
  readonly connection: ReadonlyArray<string>;
  readonly channel: string;
  readonly table: string | undefined;
  readonly credentials: ReadonlyArray<string>;
  readonly cli: ReadonlyArray<string>;
}

function parseArgs(argv: ReadonlyArray<string>): Options | "help" {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") return "help";
    if (token?.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${token} needs a value`);
      }
      flags.set(token.slice(2), next);
      i += 1;
    }
  }

  const connection: Array<string> = [];
  const url = flags.get("url");
  const apiKey = flags.get("api-key");
  if (url !== undefined) connection.push("--url", url);
  if (apiKey !== undefined) connection.push("--api-key", apiKey);

  const credentials: Array<string> = [];
  const email = flags.get("email");
  const password = flags.get("password");
  if (email !== undefined && password !== undefined) {
    credentials.push("--email", email, "--password", password);
  }

  const explicitCli = flags.get("cli");
  const builtBinary = new URL("../dist/supabase", import.meta.url).pathname;
  const cli =
    explicitCli !== undefined
      ? [explicitCli]
      : Bun.file(builtBinary).size > 0
        ? [builtBinary]
        : ["bun", new URL("../src/main.ts", import.meta.url).pathname];

  return {
    connection,
    channel: flags.get("channel") ?? "demo-room",
    table: flags.get("table"),
    credentials,
    cli,
  };
}

const DIM = "[2m";
const BOLD = "[1m";
const CYAN = "[36m";
const YELLOW = "[33m";
const RESET = "[0m";

const TEXT = ["--output-format", "text"] as const;

let step = 0;

function heading(title: string, why: string): void {
  step += 1;
  console.log(`\n${BOLD}${CYAN}${step}. ${title}${RESET}`);
  console.log(`${DIM}   ${why}${RESET}\n`);
}

function skip(reason: string): void {
  console.log(`${YELLOW}   skipped: ${reason}${RESET}`);
}

function shown(args: ReadonlyArray<string>): string {
  const redacted = args.map((arg, index) =>
    index > 0 && /^(sb_(publishable|secret)_|eyJ)/.test(arg)
      ? "<key>"
      : args[index - 1] === "--password"
        ? "<password>"
        : arg,
  );
  return `$ supabase ${redacted.join(" ")}`;
}

async function run(
  opts: Options,
  args: ReadonlyArray<string>,
  render: (out: string) => void,
): Promise<number> {
  console.log(`${DIM}${shown(args)}${RESET}`);
  const child = Bun.spawn([...opts.cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const exitCode = await child.exited;
  render(stripNoise(`${stdout}${stderr}`));
  console.log(`${DIM}   exit ${exitCode}${RESET}`);
  return exitCode;
}

function stripNoise(text: string): string {
  return text
    .replaceAll(/\[[\d;?]*[A-Za-z]/g, "")
    .split("\n")
    .filter(
      (line) =>
        line.trim().length > 0 &&
        !line.includes("A new version of Supabase CLI") &&
        !line.includes("We recommend updating regularly") &&
        !/^[│◒◐◓◑]/.test(line.trim()),
    )
    .join("\n");
}

function indent(text: string): void {
  for (const line of text.split("\n")) console.log(`   ${line}`);
}

async function startTail(
  opts: Options,
  args: ReadonlyArray<string>,
  ready: string,
): Promise<{ readonly output: () => Promise<string>; readonly child: Bun.Subprocess }> {
  console.log(`${DIM}${shown(args)}${DIM} ${DIM}(in another terminal)${RESET}`);
  const child = Bun.spawn([...opts.cli, ...args], { stdout: "pipe", stderr: "pipe" });

  let buffered = "";
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const collected = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
    }
    return buffered;
  })();

  const deadline = Date.now() + 20_000;
  while (!buffered.includes(ready) && Date.now() < deadline) {
    await Bun.sleep(50);
  }
  if (!buffered.includes(ready)) {
    console.log(
      `${YELLOW}   (the tail never reported being ready; the next step may miss it)${RESET}`,
    );
  }

  return { output: () => collected, child };
}

async function main(): Promise<number> {
  const parsed = parseArgs(Bun.argv.slice(2));
  if (parsed === "help") {
    console.log(HELP);
    return 0;
  }
  const opts = parsed;
  const target = [...opts.connection, ...opts.credentials];

  console.log(`${BOLD}supabase inspect realtime — a guided tour${RESET}`);
  console.log(`${DIM}driving: ${opts.cli.join(" ")}${RESET}`);

  heading(
    "Is Realtime even reachable?",
    "Walks resolve -> reach -> join and names the step that breaks. This is the one to run first, always.",
  );
  const healthy = await run(
    opts,
    ["inspect", "realtime", "check", opts.channel, ...target, ...TEXT],
    indent,
  );
  if (healthy !== 0) {
    console.log(
      `\n${YELLOW}The target is not reachable, so the rest of the tour would fail too.${RESET}`,
    );
    console.log(
      `${DIM}Start a stack with \`supabase start\`, or pass --url and --api-key.${RESET}`,
    );
    return 1;
  }

  heading(
    "A failure looks like this",
    "The same command with a bad key. Notice it names the cause instead of saying 'transport error'.",
  );
  await run(
    opts,
    [
      "inspect",
      "realtime",
      "check",
      opts.channel,
      ...opts.connection.slice(0, 2),
      "--api-key",
      "sb_publishable_deliberately_wrong",
      ...TEXT,
    ],
    indent,
  );

  heading(
    "Did my broadcast actually arrive?",
    "One session tails the channel while another sends to it — the only way to tell a delivery problem from a publishing problem.",
  );
  const tail = await startTail(
    opts,
    ["inspect", "realtime", "listen", opts.channel, ...target, "--duration", "12s", ...TEXT],
    "TIME",
  );
  await run(
    opts,
    [
      "inspect",
      "realtime",
      "broadcast",
      opts.channel,
      "demo-event",
      JSON.stringify({ hello: "world" }),
      ...target,
      ...TEXT,
    ],
    indent,
  );
  console.log(`${DIM}   ...the tail received:${RESET}`);
  indent(stripNoise(await tail.output()));

  heading(
    "What an agent sees",
    "The same tail as NDJSON: one structured frame per message on stdout, diagnostics on stderr.",
  );
  const agentTail = await startTail(
    opts,
    [
      "inspect",
      "realtime",
      "listen",
      opts.channel,
      ...target,
      "--duration",
      "10s",
      "--categories",
      "all",
      "--output-format",
      "stream-json",
    ],
    '"type":',
  );
  await run(
    opts,
    [
      "inspect",
      "realtime",
      "broadcast",
      opts.channel,
      "agent-event",
      JSON.stringify({ n: 1 }),
      ...target,
    ],
    () => {},
  );
  indent(stripNoise(await agentTail.output()));
  console.log(
    `${DIM}   Pipe that to jq: ... --output-format stream-json | jq -c 'select(.type=="realtime-frame")'${RESET}`,
  );

  heading(
    "Who else is on this channel?",
    "One session holds a presence membership open; another reads the state as JSON.",
  );
  const presenceTail = await startTail(
    opts,
    [
      "inspect",
      "realtime",
      "listen",
      opts.channel,
      ...target,
      "--as",
      "demo-watcher",
      "--duration",
      "12s",
      ...TEXT,
    ],
    "TIME",
  );
  await run(
    opts,
    ["inspect", "realtime", "presence", opts.channel, ...target, "--output-format", "json"],
    indent,
  );
  await presenceTail.output();

  heading(
    "Are database changes reaching subscribers?",
    "The classic 'my subscription never fires'. The command separates 'the server refused the subscription' from 'the subscription is live but nothing is arriving'.",
  );
  if (opts.table === undefined) {
    skip("no --table given. Pass --table public.your_table to include this step.");
    console.log(`${DIM}   The table must be in the supabase_realtime publication, and the${RESET}`);
    console.log(`${DIM}   subscribing role must be able to read it under RLS.${RESET}`);
  } else {
    await run(
      opts,
      [
        "inspect",
        "realtime",
        "check",
        opts.channel,
        ...target,
        "--postgres",
        opts.table,
        "--output-format",
        "text",
      ],
      indent,
    );
    console.log(
      `${DIM}   To watch changes live: supabase inspect realtime listen --postgres ${opts.table}${RESET}`,
    );
    console.log(
      `${DIM}   ...then insert a row and watch the frame arrive with its commit lag.${RESET}`,
    );
  }

  heading(
    "Is it RLS, or is it broken?",
    "A private channel enforces RLS. Comparing an anonymous join, a signed-in join and a service-role join tells you which layer is refusing you.",
  );
  if (opts.credentials.length === 0) {
    skip("no --email/--password given, so there is no user to join as.");
    console.log(
      `${DIM}   With a user: ... check <channel> --private --email you@example.com --password ...${RESET}`,
    );
  } else {
    console.log(`${DIM}   as an anonymous client:${RESET}`);
    await run(
      opts,
      ["inspect", "realtime", "check", opts.channel, "--private", ...opts.connection, ...TEXT],
      indent,
    );
    console.log(`${DIM}   as a signed-in user:${RESET}`);
    await run(
      opts,
      ["inspect", "realtime", "check", opts.channel, "--private", ...target, ...TEXT],
      indent,
    );
    console.log(
      `${DIM}   If the user is refused too, add a realtime.messages policy for the topic.${RESET}`,
    );
    console.log(
      `${DIM}   If --service-role joins but your user does not, the policy is the problem.${RESET}`,
    );
  }

  console.log(`\n${BOLD}Where to go next${RESET}`);
  console.log(`${DIM}  supabase inspect realtime --help${RESET}`);
  console.log(`${DIM}  supabase inspect realtime listen --help   # 25 flags, all optional${RESET}`);
  console.log(`${DIM}  apps/cli/docs/inspect-realtime.md         # the written guide${RESET}`);
  return 0;
}

process.exit(await main());
