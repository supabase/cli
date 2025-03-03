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
	"github.com/supabase/cli/pkg/pgxv5"
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
	// IPv6 address must be wrapped in square brackets
	host := config.Host
	if ip := net.ParseIP(host); ip != nil && ip.To4() == nil {
		host = fmt.Sprintf("[%s]", host)
	}
	return fmt.Sprintf(
		"postgresql://%s@%s:%d/%s?%s",
		url.UserPassword(config.User, config.Password),
		host,
		config.Port,
		url.PathEscape(config.Database),
		queryParams,
	)
}

func GetPoolerConfig(projectRef string) *pgconn.Config {
	logger := GetDebugLogger()
	if len(Config.Db.Pooler.ConnectionString) == 0 {
		fmt.Fprintln(logger, "Pooler URL is not configured")
		return nil
	}
	poolerConfig, err := ParsePoolerURL(Config.Db.Pooler.ConnectionString)
	if err != nil {
		fmt.Fprintln(logger, err)
		return nil
	}
	if poolerConfig.RuntimeParams == nil {
		poolerConfig.RuntimeParams = make(map[string]string)
	}
	// Verify that the pooler username matches the database host being connected to
	if _, ref, found := strings.Cut(poolerConfig.User, "."); !found {
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
	fmt.Fprintln(logger, "Using connection pooler:", Config.Db.Pooler.ConnectionString)
	// Supavisor transaction mode does not support prepared statement
	poolerConfig.Port = 5432
	return poolerConfig
}

func ParsePoolerURL(connString string) (*pgconn.Config, error) {
	// Remove password from pooler connection string because the placeholder text
	// [YOUR-PASSWORD] messes up pgconn.ParseConfig. The password must be percent
	// escaped so we cannot simply call strings.Replace with actual password.
	poolerUrl := strings.ReplaceAll(connString, "[YOUR-PASSWORD]", "")
	poolerConfig, err := pgconn.ParseConfig(poolerUrl)
	if err != nil {
		return nil, errors.Errorf("failed to parse pooler URL: %w", err)
	}
	return poolerConfig, nil
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
		config.Port = Config.Db.Port
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
	if viper.GetBool("DEBUG") {
		options = append(options, debug.SetupPGX)
	}
	return pgxv5.Connect(ctx, url, options...)
}

func ConnectByConfigStream(ctx context.Context, config pgconn.Config, w io.Writer, options ...func(*pgx.ConnConfig)) (*pgx.Conn, error) {
	if IsLocalDatabase(config) {
		fmt.Fprintln(w, "Connecting to local database...")
		return ConnectLocalPostgres(ctx, config, options...)
	}
	fmt.Fprintln(w, "Connecting to remote database...")
	opts := append(options, func(cc *pgx.ConnConfig) {
		if DNSResolver.Value == DNS_OVER_HTTPS {
			cc.LookupFunc = FallbackLookupIP
		}
	})
	return ConnectByUrl(ctx, ToPostgresURL(config), opts...)
}

func ConnectByConfig(ctx context.Context, config pgconn.Config, options ...func(*pgx.ConnConfig)) (*pgx.Conn, error) {
	return ConnectByConfigStream(ctx, config, os.Stderr, options...)
}

func IsLocalDatabase(config pgconn.Config) bool {
	return config.Host == Config.Hostname && config.Port == Config.Db.Port
}
