/**
 * Poll an Edge Function endpoint until the gateway can actually serve it.
 *
 * The edge-runtime reports its status as "Healthy" as soon as its control
 * plane answers `/_internal/health`, but that signal is independent of any
 * individual function: the first request to a given function lazily cold-boots
 * a user worker. While that worker boots, the local gateway can briefly return
 * a transient 502/503, so first-request assertions must wait for the function
 * to become servable instead of assuming readiness from the health status.
 *
 * Transport errors and 502/503 responses are treated as "not ready yet" and
 * retried; any other response (including a 4xx/5xx the function itself emits)
 * is returned as-is so real failures still surface.
 */
export async function fetchFunctionWhenReady(
  url: string,
  init?: RequestInit,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const intervalMs = opts.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let lastResponse: Response | undefined;
  let lastError: unknown;

  for (;;) {
    try {
      const res = await fetch(url, init);
      if (res.status !== 502 && res.status !== 503) {
        return res;
      }
      lastResponse = res;
    } catch (error) {
      lastError = error;
    }

    if (Date.now() >= deadline) {
      if (lastResponse) return lastResponse;
      throw (
        lastError ?? new Error(`Edge Function at ${url} did not become ready in ${timeoutMs}ms`)
      );
    }

    await Bun.sleep(intervalMs);
  }
}

/**
 * Create the test table (todos) with RLS and seed data.
 */
export async function setupTestTable(dbPort: number): Promise<void> {
  const sql = new Bun.SQL(`postgresql://supabase_admin:postgres@127.0.0.1:${dbPort}/postgres`);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.todos (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      completed BOOLEAN NOT NULL DEFAULT false
    );

    ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'todos' AND policyname = 'allow_all') THEN
        CREATE POLICY allow_all ON public.todos FOR ALL USING (true) WITH CHECK (true);
      END IF;
    END $$;

    GRANT ALL ON public.todos TO anon, authenticated, service_role;
    GRANT USAGE, SELECT ON SEQUENCE public.todos_id_seq TO anon, authenticated, service_role;

    INSERT INTO public.todos (title, completed) VALUES
      ('Learn Supabase', true),
      ('Build an app', false);
  `);

  // PostgREST caches schema metadata, so tell it to reload after creating test tables.
  await sql.unsafe(`NOTIFY pgrst, 'reload schema';`);

  sql.close();
}
