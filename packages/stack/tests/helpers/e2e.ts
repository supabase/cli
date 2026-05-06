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
