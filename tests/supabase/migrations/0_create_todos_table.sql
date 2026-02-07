-- Create a test table
CREATE TABLE IF NOT EXISTS public.todos (
    id SERIAL PRIMARY KEY,
    task TEXT NOT NULL,
    done BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;

-- Allow anon to read all todos
CREATE POLICY "Allow anon read" ON public.todos FOR SELECT TO anon USING (true);

-- Allow authenticated users full access
CREATE POLICY "Allow authenticated full access" ON public.todos FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Grant permissions
GRANT SELECT ON public.todos TO anon;
GRANT ALL ON public.todos TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.todos_id_seq TO authenticated;
