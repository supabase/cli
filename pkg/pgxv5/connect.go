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
	CLI_LOGIN_ROLE   = "cli_login_postgres"
	SET_SESSION_ROLE = "SET SESSION ROLE postgres"
)

// Extends pgx.Connect with support for programmatically overriding parsed config
func Connect(ctx context.Context, connString string, options ...func(*pgx.ConnConfig)) (*pgx.Conn, error) {
	// Parse connection url
	config, err := pgx.ParseConfig(connString)
	if err != nil {
		return nil, errors.Errorf("failed to parse connection string: %w", err)
	}
	config.OnNotice = func(pc *pgconn.PgConn, n *pgconn.Notice) {
		fmt.Fprintf(os.Stderr, "%s (%s): %s\n", n.Severity, n.Code, n.Message)
	}
	if strings.HasPrefix(config.User, CLI_LOGIN_ROLE) {
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
