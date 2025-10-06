package pgxv5

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
)

const (
	CLI_LOGIN_PREFIX = "cli_login_"
	SET_SESSION_ROLE = "SET SESSION ROLE postgres"
	SUPERUSER_ROLE   = "supabase_admin"
)

// Extends pgx.Connect with support for programmatically overriding parsed config
func Connect(ctx context.Context, connString string, options ...func(*pgx.ConnConfig)) (*pgx.Conn, error) {
	// Parse connection url
	config, err := pgx.ParseConfig(connString)
	if err != nil {
		return nil, errors.Errorf("failed to parse connection string: %w", err)
	}
	config.OnNotice = func(pc *pgconn.PgConn, n *pgconn.Notice) {
		if !shouldIgnore(n.Message) {
			fmt.Fprintf(os.Stderr, "%s (%s): %s\n", n.Severity, n.Code, n.Message)
		}
	}
	user := strings.Split(config.User, ".")[0]
	if strings.HasPrefix(user, CLI_LOGIN_PREFIX) || strings.EqualFold(user, SUPERUSER_ROLE) {
		config.AfterConnect = func(ctx context.Context, pgconn *pgconn.PgConn) error {
			return pgconn.Exec(ctx, SET_SESSION_ROLE).Close()
		}
	}
	// Apply config overrides
	for _, op := range options {
		op(config)
	}
	// Connect to database
	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return nil, errors.Errorf("failed to connect to postgres: %w", err)
	}
	return conn, nil
}

func shouldIgnore(msg string) bool {
	return strings.Contains(msg, `schema "supabase_migrations" already exists`) ||
		strings.Contains(msg, `relation "schema_migrations" already exists`) ||
		strings.Contains(msg, `relation "seed_files" already exists`)
}
