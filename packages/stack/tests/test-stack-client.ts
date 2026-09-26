/* oxlint-disable effecttsgo/async-function, effecttsgo/global-fetch -- This fixture exercises the Promise testing API as a non-Effect consumer does. */
import { discover, postgres, type Stack } from "../src/index.ts";
import { createTestStack } from "../src/testing.ts";

const check = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

const sql = async (stack: Stack, databaseUrl: string, command: string) => {
  const errors: Array<string> = [];
  const result = await stack.tools.run(postgres.psql({ major: 17 }), {
    args: ["--dbname", databaseUrl, "--set", "ON_ERROR_STOP=1", "--command", command],
    stdout: () => {},
    stderr: (bytes) => {
      errors.push(new TextDecoder().decode(bytes));
    },
  });
  check(result.exitCode === 0, `psql failed: ${errors.join("")}`);
};

const readRows = async (restUrl: string) => {
  const response = await fetch(`${restUrl}/checkpoint_rows?select=value&order=value`);
  const body = await response.text();
  check(response.status === 200, `REST read failed with ${response.status}: ${body}`);
  return JSON.stringify(JSON.parse(body));
};

const stateRoot = process.argv[2];
if (stateRoot === undefined) throw new Error("Missing fixture state root");

let disposed: { readonly stackId: string; readonly projectRoot: string } | undefined;
{
  await using test = await createTestStack({ services: ["database", "rest"], stateRoot });
  const registered = await discover({ stateRoot });
  check(
    registered.some((entry) => entry.definition.id === test.stack.id),
    "Test stack is not registered under the fixture state root",
  );
  disposed = { stackId: test.stack.id, projectRoot: test.projectRoot };
  const { databaseUrl } = await test.services.database.credentials({ from: "runtime" });
  const { url: restUrl } = await test.services.rest.credentials();
  if (databaseUrl === undefined || restUrl === undefined) throw new Error("Endpoints missing");
  await sql(
    test.stack,
    databaseUrl,
    "CREATE TABLE public.checkpoint_rows (value text NOT NULL); GRANT SELECT ON public.checkpoint_rows TO anon; INSERT INTO public.checkpoint_rows VALUES ('seeded');",
  );
  await test.checkpoint("seeded");
  await sql(test.stack, databaseUrl, "INSERT INTO public.checkpoint_rows VALUES ('scratch');");
  const beforeReset = await readRows(restUrl);
  check(beforeReset === '[{"value":"scratch"},{"value":"seeded"}]', `Before reset: ${beforeReset}`);

  await test.reset("seeded");

  const afterReset = await readRows(restUrl);
  check(afterReset === '[{"value":"seeded"}]', `After reset: ${afterReset}`);
}
process.stdout.write(`${JSON.stringify(disposed)}\n`);
