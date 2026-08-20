import type { Session } from "@supabase/supabase-js";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { supabase, type Todo } from "../lib/supabase.ts";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  // Session starts undefined so the server render and the first client render
  // both show the loading state, avoiding a hydration mismatch.
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) {
    return <main style={styles.page}>Loading…</main>;
  }
  return (
    <main style={styles.page}>
      <h1>Supabase Todos</h1>
      {session === null ? <AuthForm /> : <TodoList session={session} />}
    </main>
  );
}

function AuthForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (mode: "sign-up" | "sign-in") => {
    setBusy(true);
    setError(null);
    // Local auth runs with email autoconfirm, so sign-up returns a live
    // session immediately — no confirmation email round-trip.
    const { error: authError } =
      mode === "sign-up"
        ? await supabase.auth.signUp({ email, password })
        : await supabase.auth.signInWithPassword({ email, password });
    if (authError) setError(authError.message);
    setBusy(false);
  };

  return (
    <form style={styles.card} onSubmit={(e) => e.preventDefault()}>
      <p>Sign in with email and password. New here? Sign up — no email confirmation needed.</p>
      <input
        type="email"
        placeholder="you@example.com"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        style={styles.input}
      />
      <input
        type="password"
        placeholder="password (min 6 chars)"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        style={styles.input}
      />
      <div style={styles.row}>
        <button type="submit" disabled={busy} onClick={() => submit("sign-in")} style={styles.button}>
          Sign in
        </button>
        <button type="button" disabled={busy} onClick={() => submit("sign-up")} style={styles.button}>
          Sign up
        </button>
      </div>
      {error !== null && (
        <p role="alert" style={styles.error}>
          {error}
        </p>
      )}
    </form>
  );
}

function TodoList({ session }: { session: Session }) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data, error: selectError } = await supabase
      .from("todos")
      .select("*")
      .order("inserted_at", { ascending: true })
      .order("id", { ascending: true });
    if (selectError) setError(selectError.message);
    else setTodos((data as Todo[] | null) ?? []);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addTodo = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (trimmed === "") return;
    setError(null);
    const { error: insertError } = await supabase.from("todos").insert({ title: trimmed });
    if (insertError) setError(insertError.message);
    else {
      setTitle("");
      await refresh();
    }
  };

  const toggleTodo = async (todo: Todo) => {
    setError(null);
    const { error: updateError } = await supabase
      .from("todos")
      .update({ done: !todo.done })
      .eq("id", todo.id);
    if (updateError) setError(updateError.message);
    else await refresh();
  };

  const deleteTodo = async (todo: Todo) => {
    setError(null);
    const { error: deleteError } = await supabase.from("todos").delete().eq("id", todo.id);
    if (deleteError) setError(deleteError.message);
    else await refresh();
  };

  return (
    <section style={styles.card}>
      <div style={styles.row}>
        <span data-testid="signed-in-as">Signed in as {session.user.email}</span>
        <button type="button" onClick={() => void supabase.auth.signOut()} style={styles.button}>
          Sign out
        </button>
      </div>
      <form onSubmit={addTodo} style={styles.row}>
        <input
          placeholder="What needs doing?"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={{ ...styles.input, flex: 1 }}
        />
        <button type="submit" style={styles.button}>
          Add
        </button>
      </form>
      <ul data-testid="todo-list" style={styles.list}>
        {todos.map((todo) => (
          <li key={todo.id} style={styles.item}>
            <label style={{ ...styles.row, flex: 1 }}>
              <input type="checkbox" checked={todo.done} onChange={() => void toggleTodo(todo)} />
              <span style={todo.done ? styles.done : undefined}>{todo.title}</span>
            </label>
            <button type="button" onClick={() => void deleteTodo(todo)} style={styles.button}>
              Delete
            </button>
          </li>
        ))}
      </ul>
      {todos.length === 0 && <p>No todos yet. Add one above.</p>}
      {error !== null && (
        <p role="alert" style={styles.error}>
          {error}
        </p>
      )}
    </section>
  );
}

const styles = {
  page: {
    fontFamily: "system-ui, sans-serif",
    maxWidth: 560,
    margin: "3rem auto",
    padding: "0 1rem",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
    border: "1px solid #ddd",
    borderRadius: 8,
    padding: "1rem",
  },
  row: { display: "flex", gap: "0.5rem", alignItems: "center" },
  input: { padding: "0.5rem", border: "1px solid #ccc", borderRadius: 6 },
  button: {
    padding: "0.4rem 0.8rem",
    border: "1px solid #3ecf8e",
    borderRadius: 6,
    background: "#3ecf8e",
    color: "#fff",
    cursor: "pointer",
  },
  list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" },
  item: { display: "flex", gap: "0.5rem", alignItems: "center" },
  done: { textDecoration: "line-through", color: "#888" },
  error: { color: "#c00", margin: 0 },
} satisfies Record<string, React.CSSProperties>;
