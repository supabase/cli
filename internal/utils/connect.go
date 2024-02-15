package utils

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/debug"
)

func ToPostgresURL(config pgconn.Config) string {
	timeoutSecond := int64(config.ConnectTimeout.Seconds())
	if timeoutSecond == 0 {
		timeoutSecond = 10
	}
	queryParams := fmt.Sprintf("connect_timeout=%d", timeoutSecond)
	for k, v := range config.RuntimeParams {
		queryParams += fmt.Sprintf("&%s=%s", k, url.QueryEscape(v))
	}
	return fmt.Sprintf(
		"postgresql://%s@%s:%d/%s?%s",
		url.UserPassword(config.User, config.Password),
		config.Host,
		config.Port,
		url.PathEscape(config.Database),
		queryParams,
	)
}

// Connnect to remote Postgres with optimised settings. The caller is responsible for closing the connection returned.
func ConnectRemotePostgres(ctx context.Context, config pgconn.Config, options ...func(*pgx.ConnConfig)) (*pgx.Conn, error) {
	// Simple protocol is preferred over pgx default Parse -> Bind flow because
	//   1. Using a single command for each query reduces RTT over an Internet connection.
	//   2. Performance gains from using the alternate binary protocol is negligible because
	//      we are only selecting from migrations table. Large reads are handled by PostgREST.
	//   3. Any prepared statements are cleared server side upon closing the TCP connection.
	//      Since CLI workloads are one-off scripts, we don't use connection pooling and hence
	//      don't benefit from per connection server side cache.
	opts := append(options, func(cc *pgx.ConnConfig) {
		cc.PreferSimpleProtocol = true
		if DNSResolver.Value == DNS_OVER_HTTPS {
			cc.LookupFunc = FallbackLookupIP
		}
	})
	return ConnectByUrl(ctx, ToPostgresURL(config), opts...)
}

func GetPoolerConfig(projectRef string) *pgconn.Config {
	logger := getDebugLogger()
	if len(Config.Db.Pooler.ConnectionString) == 0 {
		fmt.Fprintln(logger, "Pooler URL is not configured")
		return nil
	}
	// Remove password from pooler connection string because the placeholder text
	// [YOUR-PASSWORD] messes up pgconn.ParseConfig. The password must be percent
	// escaped so we cannot simply call strings.Replace with actual password.
	poolerUrl := strings.ReplaceAll(Config.Db.Pooler.ConnectionString, "[YOUR-PASSWORD]", "")
	poolerConfig, err := pgconn.ParseConfig(poolerUrl)
	if err != nil {
		fmt.Fprintln(logger, "Failed to parse pooler URL:", poolerUrl)
		return nil
	}
	// Verify that the pooler username matches the database host being connected to
	_, ref, found := strings.Cut(poolerConfig.User, ".")
	if !found {
		for _, option := range strings.Split(poolerConfig.RuntimeParams["options"], ",") {
			key, value, found := strings.Cut(option, "=")
			if found && key == "reference" && value != projectRef {
				fmt.Fprintln(logger, "Pooler options does not match project ref:", projectRef)
				return nil
			}
		}
	} else if projectRef != ref {
		fmt.Fprintln(logger, "Pooler username does not match project ref:", projectRef)
		return nil
	}
	// There is a risk of MITM attack if we simply trust the hostname specified in pooler URL.
	if !isSupabaseDomain(poolerConfig.Host) {
		fmt.Fprintln(logger, "Pooler hostname does not belong to Supabase domain:", poolerConfig.Host)
		return nil
	}
	fmt.Fprintln(logger, "Using connection pooler:", poolerUrl)
	return poolerConfig
}

func getDebugLogger() io.Writer {
	if viper.GetBool("DEBUG") {
		return os.Stderr
	}
	return io.Discard
}

func isSupabaseDomain(host string) bool {
	switch GetSupabaseAPIHost() {
	case "https://api.supabase.green":
		return strings.HasSuffix(host, ".supabase.green")
	default:
		return strings.HasSuffix(host, ".supabase.com")
	}
}

// Connnect to local Postgres with optimised settings. The caller is responsible for closing the connection returned.
func ConnectLocalPostgres(ctx context.Context, config pgconn.Config, options ...func(*pgx.ConnConfig)) (*pgx.Conn, error) {
	if len(config.Host) == 0 {
		config.Host = Config.Hostname
	}
	if config.Port == 0 {
		config.Port = uint16(Config.Db.Port)
	}
	if len(config.User) == 0 {
		config.User = "postgres"
	}
	if len(config.Password) == 0 {
		config.Password = Config.Db.Password
	}
	if len(config.Database) == 0 {
		config.Database = "postgres"
	}
	if config.ConnectTimeout == 0 {
		config.ConnectTimeout = 2 * time.Second
	}
	return ConnectByUrl(ctx, ToPostgresURL(config), options...)
}

func ConnectByUrl(ctx context.Context, url string, options ...func(*pgx.ConnConfig)) (*pgx.Conn, error) {
	// Parse connection url
	config, err := pgx.ParseConfig(url)
	if err != nil {
		return nil, errors.Errorf("failed to parse postgres url: %w", err)
	}
	// Apply config overrides
	for _, op := range options {
		op(config)
	}
	if viper.GetBool("DEBUG") {
		debug.SetupPGX(config)
	}
	// Connect to database
	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return nil, errors.Errorf("failed to connect to postgres: %w", err)
	}
	return conn, nil
}

func ConnectByConfig(ctx context.Context, config pgconn.Config, options ...func(*pgx.ConnConfig)) (*pgx.Conn, error) {
	if IsLoopback(config.Host) {
		fmt.Fprintln(os.Stderr, "Connecting to local database...")
		return ConnectLocalPostgres(ctx, config, options...)
	}
	fmt.Fprintln(os.Stderr, "Connecting to remote database...")
	return ConnectRemotePostgres(ctx, config, options...)
}

func IsLoopback(host string) bool {
	if strings.ToLower(host) == "localhost" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return false
}
