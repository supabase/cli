// pgprobe empirically compares three migration-file execution models against a
// live Postgres server:
//
//	pipeline:  every statement queued on one pgconn.Batch with a single Sync —
//	           byte-for-byte what branching's MigrationFile.ExecBatch does today.
//	explicit:  sequential statements wrapped in BEGIN/COMMIT with ROLLBACK on
//	           error — the supabase/cli#6354 (CLI-2261) proposal.
//	autocommit: sequential statements with no wrapper — the pg-delta
//	           `-- pg-delta: transaction=false` directive model (CLI-2280).
//
// Each scenario uses a fresh connection and fresh object names, and verifies
// the resulting database state, not just the error string.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var connString = os.Getenv("PGPROBE_URL")

func connect(ctx context.Context) *pgx.Conn {
	deadline := time.Now().Add(3 * time.Minute)
	for {
		conn, err := pgx.Connect(ctx, connString)
		if err == nil {
			return conn
		}
		if time.Now().After(deadline) {
			fmt.Fprintf(os.Stderr, "cannot connect: %v\n", err)
			os.Exit(1)
		}
		time.Sleep(2 * time.Second)
	}
}

// pipeline mirrors branching's ExecBatch: one pgconn.Batch, anonymous
// ExecParams per statement, single Sync via ExecBatch.
func pipeline(ctx context.Context, conn *pgx.Conn, stmts []string) error {
	batch := &pgconn.Batch{}
	for _, s := range stmts {
		batch.ExecParams(s, nil, nil, nil, nil)
	}
	_, err := conn.PgConn().ExecBatch(ctx, batch).ReadAll()
	return err
}

// autocommit mirrors the directive model: one anonymous ExecParams per
// statement, one Sync each, no wrapper.
func autocommit(ctx context.Context, conn *pgx.Conn, stmts []string) error {
	for _, s := range stmts {
		if result := conn.PgConn().ExecParams(ctx, s, nil, nil, nil, nil).Read(); result.Err != nil {
			return result.Err
		}
	}
	return nil
}

// explicit mirrors the CLI-2261 model: BEGIN, sequential statements, COMMIT,
// best-effort ROLLBACK on failure.
func explicit(ctx context.Context, conn *pgx.Conn, stmts []string) error {
	if err := autocommit(ctx, conn, []string{"begin"}); err != nil {
		return err
	}
	if err := autocommit(ctx, conn, stmts); err != nil {
		_ = autocommit(ctx, conn, []string{"rollback"})
		return err
	}
	return autocommit(ctx, conn, []string{"commit"})
}

func sqlstate(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code + " " + pgErr.Message
	}
	if err == nil {
		return "OK"
	}
	return err.Error()
}

func check(ctx context.Context, query string) bool {
	conn := connect(ctx)
	defer conn.Close(ctx)
	var found bool
	if err := conn.QueryRow(ctx, query).Scan(&found); err != nil {
		return false
	}
	return found
}

const tableExists = "select exists (select from pg_tables where schemaname = 'public' and tablename = $1)"

func tableCheck(ctx context.Context, name string) bool {
	conn := connect(ctx)
	defer conn.Close(ctx)
	var found bool
	if err := conn.QueryRow(ctx, tableExists, name).Scan(&found); err != nil {
		return false
	}
	return found
}

func validIndex(ctx context.Context, name string) string {
	conn := connect(ctx)
	defer conn.Close(ctx)
	var valid bool
	err := conn.QueryRow(ctx, "select indisvalid from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = $1", name).Scan(&valid)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "absent"
		}
		return "error: " + err.Error()
	}
	if valid {
		return "EXISTS (valid)"
	}
	return "EXISTS (invalid)"
}

type row struct{ id, approach, outcome, state string }

var report []row

func run(ctx context.Context, id, approach string, setup, stmts []string, verify func(context.Context) string) {
	conn := connect(ctx)
	defer conn.Close(ctx)
	if len(setup) > 0 {
		if err := autocommit(ctx, conn, setup); err != nil {
			report = append(report, row{id, approach, "SETUP FAILED: " + sqlstate(err), ""})
			return
		}
	}
	var err error
	switch approach {
	case "pipeline":
		err = pipeline(ctx, conn, stmts)
	case "explicit-txn":
		err = explicit(ctx, conn, stmts)
	case "autocommit":
		err = autocommit(ctx, conn, stmts)
	}
	state := ""
	if verify != nil {
		state = verify(ctx)
	}
	report = append(report, row{id, approach, sqlstate(err), state})
}

func main() {
	ctx := context.Background()
	conn := connect(ctx)
	var version string
	if err := conn.QueryRow(ctx, "show server_version").Scan(&version); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	conn.Close(ctx)
	fmt.Printf("server_version: %s\n\n", version)

	// S1: plain multi-statement file with a mid-file failure. The atomicity
	// qiao's claim is about: do earlier statements roll back?
	s1 := func(suffix string) ([]string, []string, func(context.Context) string) {
		a, b := "s1_a_"+suffix, "s1_b_"+suffix
		stmts := []string{
			"create table " + a + " (id int primary key)",
			"insert into " + a + " values (1)",
			"insert into " + a + " values (1)", // unique violation
			"create table " + b + " (id int)",
		}
		verify := func(ctx context.Context) string {
			return fmt.Sprintf("table %s exists: %v, table %s exists: %v", a, tableCheck(ctx, a), b, tableCheck(ctx, b))
		}
		return nil, stmts, verify
	}
	for _, ap := range []string{"pipeline", "explicit-txn", "autocommit"} {
		setup, stmts, verify := s1(ap[:4])
		run(ctx, "S1 mid-file failure: earlier statements rolled back?", ap, setup, stmts, verify)
	}

	// S2: the pg-delta generated layout — session preamble, then CREATE INDEX
	// CONCURRENTLY, then cleanup. The action is never the first statement.
	s2 := func(suffix string) ([]string, []string, func(context.Context) string) {
		t, idx := "s2_t_"+suffix, "s2_idx_"+suffix
		setup := []string{"create table " + t + " (c int)"}
		stmts := []string{
			"set check_function_bodies = off",
			"create index concurrently " + idx + " on " + t + " (c)",
			"reset all",
		}
		verify := func(ctx context.Context) string { return "index " + idx + ": " + validIndex(ctx, idx) }
		return setup, stmts, verify
	}
	for _, ap := range []string{"pipeline", "explicit-txn", "autocommit"} {
		setup, stmts, verify := s2(ap[:4])
		run(ctx, "S2 pg-delta layout: SET, CREATE INDEX CONCURRENTLY, RESET ALL", ap, setup, stmts, verify)
	}

	// S3: LOCK TABLE guarding a later ALTER — the supabase/cli#6347 case.
	s3 := func(suffix string) ([]string, []string, func(context.Context) string) {
		t := "s3_t_" + suffix
		stmts := []string{
			"create table " + t + " (id int primary key)",
			"lock table " + t + " in access exclusive mode",
			"alter table " + t + " add column note text",
		}
		verify := func(ctx context.Context) string {
			ok := check(ctx, "select exists (select from information_schema.columns where table_name = '"+t+"' and column_name = 'note')")
			return fmt.Sprintf("column %s.note exists: %v", t, ok)
		}
		return nil, stmts, verify
	}
	for _, ap := range []string{"pipeline", "explicit-txn", "autocommit"} {
		setup, stmts, verify := s3(ap[:4])
		run(ctx, "S3 LOCK TABLE before ALTER (supabase/cli#6347)", ap, setup, stmts, verify)
	}

	// S4: the officially advised "standalone CONCURRENTLY file" under the
	// pipeline, including the history insert that rides in the same batch.
	// 4a: history insert succeeds. 4b: history insert fails — is the file atomic?
	run(ctx, "S4a standalone CIC file + history insert (happy path)", "pipeline",
		[]string{
			"create table s4a_t (c int)",
			"create table s4a_hist (v text primary key)",
		},
		[]string{
			"create index concurrently s4a_idx on s4a_t (c)",
			"insert into s4a_hist values ('20260101000000')",
		},
		func(ctx context.Context) string { return "index s4a_idx: " + validIndex(ctx, "s4a_idx") })
	run(ctx, "S4b standalone CIC file + FAILING history insert: atomic?", "pipeline",
		[]string{
			"create table s4b_t (c int)",
			"create table s4b_hist (v text primary key)",
			"insert into s4b_hist values ('20260101000000')", // pre-seed the duplicate
		},
		[]string{
			"create index concurrently s4b_idx on s4b_t (c)",
			"insert into s4b_hist values ('20260101000000')", // unique violation
		},
		func(ctx context.Context) string { return "index s4b_idx: " + validIndex(ctx, "s4b_idx") })

	// S5: two CONCURRENTLY statements in one file (supabase/cli#2898 comments).
	s5 := func(suffix string) ([]string, []string, func(context.Context) string) {
		ta, tb := "s5_ta_"+suffix, "s5_tb_"+suffix
		ia, ib := "s5_ia_"+suffix, "s5_ib_"+suffix
		setup := []string{"create table " + ta + " (c int)", "create table " + tb + " (c int)"}
		stmts := []string{
			"create index concurrently " + ia + " on " + ta + " (c)",
			"create index concurrently " + ib + " on " + tb + " (c)",
		}
		verify := func(ctx context.Context) string {
			return fmt.Sprintf("index %s: %s, index %s: %s", ia, validIndex(ctx, ia), ib, validIndex(ctx, ib))
		}
		return setup, stmts, verify
	}
	for _, ap := range []string{"pipeline", "autocommit"} {
		setup, stmts, verify := s5(ap[:4])
		run(ctx, "S5 two CONCURRENTLY indexes in one file", ap, setup, stmts, verify)
	}

	// S6: authored BEGIN/COMMIT inside the file. Tests the claim that pipeline
	// mode lets authors opt into a real transaction block when they need one
	// (eg. LOCK TABLE), without the runner wrapping anything.
	s6 := func(suffix string) ([]string, []string, func(context.Context) string) {
		t := "s6_t_" + suffix
		stmts := []string{
			"begin",
			"create table " + t + " (id int primary key)",
			"lock table " + t + " in access exclusive mode",
			"alter table " + t + " add column note text",
			"commit",
		}
		verify := func(ctx context.Context) string {
			ok := check(ctx, "select exists (select from information_schema.columns where table_name = '"+t+"' and column_name = 'note')")
			return fmt.Sprintf("column %s.note exists: %v", t, ok)
		}
		return nil, stmts, verify
	}
	for _, ap := range []string{"pipeline", "autocommit"} {
		setup, stmts, verify := s6(ap[:4])
		run(ctx, "S6 authored BEGIN/COMMIT + LOCK TABLE in the file", ap, setup, stmts, verify)
	}

	// S7: a file with authored BEGIN/COMMIT plus statements after the authored
	// commit, one of which fails. Neither a naive runner-added BEGIN/COMMIT nor
	// the pipeline keeps such a file atomic: the authored COMMIT punches through
	// both. This is the real "can of worms" and the reason any wrapper must
	// detect authored transaction control and step aside (as the TS CLI does).
	s7 := func(suffix string) ([]string, []string, func(context.Context) string) {
		t := "s7_t_" + suffix
		stmts := []string{
			"begin",
			"create table " + t + " (id int)",
			"commit",
			"insert into " + t + " values (1)",
			"insert into s7_nonexistent_" + suffix + " values (1)", // fails
		}
		verify := func(ctx context.Context) string {
			rows := check(ctx, "select exists (select from "+t+")")
			return fmt.Sprintf("table %s exists: %v, has rows: %v", t, tableCheck(ctx, t), rows)
		}
		return nil, stmts, verify
	}
	for _, ap := range []string{"pipeline", "explicit-txn"} {
		setup, stmts, verify := s7(ap[:4])
		run(ctx, "S7 authored COMMIT mid-file, later statement fails", ap, setup, stmts, verify)
	}

	fmt.Printf("| scenario | approach | result | database state afterwards |\n|---|---|---|---|\n")
	for _, r := range report {
		fmt.Printf("| %s | %s | %s | %s |\n", r.id, r.approach, r.outcome, r.state)
	}
}
