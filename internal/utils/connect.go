package utils

import (
	"context"
	"fmt"
	"net/url"
	"os"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/debug"
)

// Connnect to remote Postgres with optimised settings. The caller is responsible for closing the connection returned.
func ConnectRemotePostgres(ctx context.Context, username, password, database, host string, options ...func(*pgx.ConnConfig)) (*pgx.Conn, error) {
	// Use port 6543 for connection pooling
	pgUrl := fmt.Sprintf(
		"postgresql://%s@%s:6543/%s?connect_timeout=10",
		url.UserPassword(username, password),
		host,
		url.PathEscape(database),
	)
	// Parse connection url
	config, err := pgx.ParseConfig(pgUrl)
	if err != nil {
		return nil, err
	}
	// Simple protocol is preferred over pgx default Parse -> Bind flow because
	//   1. Using a single command for each query reduces RTT over an Internet connection.
	//   2. Performance gains from using the alternate binary protocol is negligible because
	//      we are only selecting from migrations table. Large reads are handled by PostgREST.
	//   3. Any prepared statements are cleared server side upon closing the TCP connection.
	//      Since CLI workloads are one-off scripts, we don't use connection pooling and hence
	//      don't benefit from per connection server side cache.
	config.PreferSimpleProtocol = true
	// Apply config overrides
	for _, op := range options {
		op(config)
	}
	if viper.GetBool("DEBUG") {
		debug.SetupPGX(config)
	}
	conn, err := pgx.ConnectConfig(ctx, config)
	if !pgconn.Timeout(err) {
		return conn, err
	}
	// Fallback to postgres when pgbouncer is unavailable
	config.Port = 5432
	fmt.Fprintln(os.Stderr, "Retrying...", config.Host, config.Port)
	return pgx.ConnectConfig(ctx, config)
}

// Connnect to local Postgres with optimised settings. The caller is responsible for closing the connection returned.
func ConnectLocalPostgres(ctx context.Context, host string, port uint, database string, options ...func(*pgx.ConnConfig)) (*pgx.Conn, error) {
	url := fmt.Sprintf("postgresql://postgres:postgres@%s:%d/%s?connect_timeout=2", host, port, database)
	// Parse connection url
	config, err := pgx.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	// Apply config overrides
	for _, op := range options {
		op(config)
	}
	if viper.GetBool("DEBUG") {
		debug.SetupPGX(config)
	}
	// Connect to database
	return pgx.ConnectConfig(ctx, config)
}
