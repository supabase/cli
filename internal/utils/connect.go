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
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/pgxv5"
	"golang.org/x/net/publicsuffix"
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

var ErrPrimaryNotFound = errors.New("primary database not found")

func GetPoolerConfigPrimary(ctx context.Context, ref string) (api.SupavisorConfigResponse, error) {
	var result api.SupavisorConfigResponse
	resp, err := GetSupabase().V1GetPoolerConfigWithResponse(ctx, ref)
	if err != nil {
		return result, errors.Errorf("failed to get pooler: %w", err)
	} else if resp.JSON200 == nil {
		return result, errors.Errorf("unexpected get pooler status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	for _, config := range *resp.JSON200 {
		if config.DatabaseType == api.SupavisorConfigResponseDatabaseTypePRIMARY {
			return config, nil
		}
	}
	return result, errors.New(ErrPrimaryNotFound)
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
		for option := range strings.SplitSeq(poolerConfig.RuntimeParams["options"], ",") {
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
	if err := assertDomainInProfile(poolerConfig.Host); err != nil {
		fmt.Fprintln(logger, err)
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

func assertDomainInProfile(host string) error {
	domain, err := publicsuffix.EffectiveTLDPlusOne(host)
	if err != nil {
		return errors.Errorf("failed to parse pooler TLD: %w", err)
	}
	if len(CurrentProfile.PoolerHost) > 0 && !strings.EqualFold(CurrentProfile.PoolerHost, domain) {
		return errors.Errorf("Pooler domain does not belong to current profile: %s", domain)
	}
	return nil
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
	options = append(options, func(cc *pgx.ConnConfig) {
		cc.TLSConfig = nil
	})
	return ConnectByUrl(ctx, ToPostgresURL(config), options...)
}

func ConnectByUrl(ctx context.Context, url string, options ...func(*pgx.ConnConfig)) (*pgx.Conn, error) {
	if viper.GetBool("DEBUG") {
		options = append(options, debug.SetupPGX)
	}
	// No fallback from TLS to unsecure connection
	options = append(options, func(cc *pgx.ConnConfig) {
		if cc.TLSConfig == nil {
			return
		}
		var fallbacks []*pgconn.FallbackConfig
		for _, fc := range cc.Fallbacks {
			if fc.TLSConfig != nil {
				fallbacks = append(fallbacks, fc)
			}
		}
		cc.Fallbacks = fallbacks
	})
	conn, err := pgxv5.Connect(ctx, url, options...)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		if strings.Contains(pgErr.Message, "connect: connection refused") {
			CmdSuggestion = fmt.Sprintf("Make sure your local IP is allowed in Network Restrictions and Network Bans.\n%s/project/_/database/settings", CurrentProfile.DashboardURL)
		} else if strings.Contains(pgErr.Message, "SSL connection is required") && viper.GetBool("DEBUG") {
			CmdSuggestion = "SSL connection is not supported with --debug flag"
		} else if strings.Contains(pgErr.Message, "SCRAM exchange: Wrong password") || strings.Contains(pgErr.Message, "failed SASL auth") {
			// password authentication failed for user / invalid SCRAM server-final-message received from server
			CmdSuggestion = "Try setting the SUPABASE_DB_PASSWORD environment variable"
		} else if strings.Contains(pgErr.Message, "connect: no route to host") || strings.Contains(pgErr.Message, "Tenant or user not found") {
			// Assumes IPv6 check has been performed before this
			CmdSuggestion = "Make sure your project exists on profile: " + CurrentProfile.Name
		}
	}
	return conn, err
}

const (
	SUPERUSER_ROLE   = "supabase_admin"
	CLI_LOGIN_PREFIX = "cli_login_"
	SET_SESSION_ROLE = "SET SESSION ROLE postgres"
)

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
		// Step down from platform provisioned login roles or privileged roles
		if user := strings.Split(cc.User, ".")[0]; strings.EqualFold(user, SUPERUSER_ROLE) ||
			strings.HasPrefix(user, CLI_LOGIN_PREFIX) {
			cc.AfterConnect = func(ctx context.Context, pgconn *pgconn.PgConn) error {
				return pgconn.Exec(ctx, SET_SESSION_ROLE).Close()
			}
		}
	})
	return ConnectByUrl(ctx, ToPostgresURL(config), opts...)
}

func ConnectByConfig(ctx context.Context, config pgconn.Config, options ...func(*pgx.ConnConfig)) (*pgx.Conn, error) {
	return ConnectByConfigStream(ctx, config, os.Stderr, options...)
}

func IsLocalDatabase(config pgconn.Config) bool {
	return config.Host == Config.Hostname && (config.Port == Config.Db.Port || config.Port == Config.Db.ShadowPort)
}
