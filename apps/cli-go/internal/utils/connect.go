package utils

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/debug"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/pgxv5"
	"golang.org/x/net/publicsuffix"
)

func ToPostgresURL(config pgconn.Config) string {
	return toPostgresURL(config, url.UserPassword(config.User, config.Password))
}

// ToPostgresURLWithoutPassword renders the connection URL exactly like
// ToPostgresURL but omits the password from the userinfo. Use it for callers that
// print the URL to stdout (the hidden `db __shadow` seam): embedding the password
// there is clear-text logging of a credential (CWE-312, flagged by CodeQL). The
// password is never the seam's to share — the TS caller that consumes the seam
// output re-injects the local Postgres password it already resolves from
// config.toml (`utils.Config.Db.Password`).
func ToPostgresURLWithoutPassword(config pgconn.Config) string {
	return toPostgresURL(config, url.User(config.User))
}

func toPostgresURL(config pgconn.Config, userinfo *url.Userinfo) string {
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
		userinfo,
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
	SetConnectSuggestion(err)
	return conn, err
}

const SuggestEnvVar = "Connect to your database by setting the env var correctly: SUPABASE_DB_PASSWORD"

// ipv6LiteralPattern matches IPv6 addresses in connection errors, e.g. Go dial
// "dial tcp [2406:da18:...]:5432" or libpq
// `connection to server at "host" (2406:da18:...), port 5432 failed`.
var ipv6LiteralPattern = regexp.MustCompile(`(?:\[[0-9a-fA-F:]+\]|\([0-9a-fA-F:]+\))`)

// isIPv6ConnectivityError reports whether the connection failure stems from the
// host resolving to an IPv6 address that the current network cannot route to.
// Supabase direct database connections (db.<ref>.supabase.co:5432) are
// IPv6-only unless the IPv4 add-on is enabled, so users on IPv4-only networks
// (or inside a Docker container without an IPv6 stack, e.g. `supabase db dump`)
// hit these failures.
func isIPv6ConnectivityError(msg string) bool {
	lower := strings.ToLower(msg)
	switch {
	case strings.Contains(lower, "address family for hostname not supported"),
		strings.Contains(lower, "no address associated with hostname"):
		// getaddrinfo inside the pg_dump container when the host is IPv6-only and
		// the container has no IPv6 stack, so AI_ADDRCONFIG filters out the AAAA
		// record: "could not translate host name ... to address: Address family
		// for hostname not supported" / "... No address associated with hostname".
		return true
	case strings.Contains(lower, "network is unreachable"):
		return true
	case strings.Contains(lower, "no route to host"),
		strings.Contains(lower, "cannot assign requested address"):
		// Require an IPv6 literal so genuine project-not-found errors (which the
		// branch below maps) keep their existing suggestion.
		return ipv6LiteralPattern.MatchString(msg)
	}
	return false
}

// IsIPv6ConnectivityError reports whether err is a database connection failure
// caused by an IPv6 address the current network (or container) cannot reach.
func IsIPv6ConnectivityError(err error) bool {
	if err == nil {
		return false
	}
	return isIPv6ConnectivityError(err.Error())
}

// ipv6Suggestion is the generic, command-agnostic hint shown when a direct
// connection fails because the host is IPv6-only. It points users at the IPv4
// transaction pooler via --db-url; SuggestIPv6Pooler upgrades it with the
// project's actual connection string when one can be fetched.
func ipv6Suggestion() string {
	return fmt.Sprintf(
		"Your network does not support IPv6, which is required for direct connections to the database.\n"+
			"Retry with your project's IPv4 transaction pooler connection string via %s.\n"+
			"You can copy it from the dashboard under Connect > Transaction pooler.",
		Aqua("--db-url"),
	)
}

// poolerURLPasswordPattern captures the userinfo password of a postgres
// connection string (the bytes between "user:" and the "@" host separator).
var poolerURLPasswordPattern = regexp.MustCompile(`^(postgres(?:ql)?://[^:@/]+:)[^@]*@`)

// maskPoolerPassword replaces the password in a pooler connection string with
// the [YOUR-PASSWORD] placeholder. The Management API may return a real password
// in connection_string, and the suggestion is printed to the terminal, so the
// password must never be echoed. The placeholder keeps the hint copy-pasteable.
func maskPoolerPassword(connString string) string {
	return poolerURLPasswordPattern.ReplaceAllString(connString, "${1}[YOUR-PASSWORD]@")
}

// ipv6PoolerSuggestion is the IPv6 hint enriched with the project's transaction
// pooler connection string (password masked), ready to paste into --db-url.
func ipv6PoolerSuggestion(connString string) string {
	return fmt.Sprintf(
		"Your network does not support IPv6, which is required for direct connections to the database.\n"+
			"Retry through the IPv4 transaction pooler by passing it to %s",
		Aqua(fmt.Sprintf(`--db-url "%s"`, maskPoolerPassword(connString))),
	)
}

// ProjectRefFromDirectDbHost extracts the project ref from a Supabase direct
// database host (db.<ref>.supabase.co|red). It returns false for any other host,
// including pooler hosts and local databases.
func ProjectRefFromDirectDbHost(host string) (string, bool) {
	matches := ProjectHostPattern.FindStringSubmatch(host)
	if len(matches) < 3 {
		return "", false
	}
	return matches[2], true
}

// WarnIPv6PoolerFallback prints a user-visible warning explaining that the direct
// database connection could not be used because the current environment does not
// support IPv6, and that the CLI is retrying through the IPv4 connection pooler.
func WarnIPv6PoolerFallback(directHost string) {
	fmt.Fprintln(os.Stderr, Yellow(fmt.Sprintf(
		"Warning: Direct connection to %s is unavailable because this environment does not support IPv6.\n"+
			"Retrying via the IPv4 connection pooler.",
		directHost,
	)))
}

// SuggestIPv6Pooler upgrades CmdSuggestion with the project's transaction pooler
// connection string when host is a Supabase direct database host and the pooler
// config can be fetched. Returns true when the suggestion was set.
func SuggestIPv6Pooler(ctx context.Context, host string) bool {
	ref, ok := ProjectRefFromDirectDbHost(host)
	if !ok {
		return false
	}
	// GetSupabase() fatally exits when no access token is configured, so only
	// reach for the API when a token is available (e.g. --db-url without login).
	if _, err := LoadAccessTokenFS(afero.NewOsFs()); err != nil {
		return false
	}
	primary, err := GetPoolerConfigPrimary(ctx, ref)
	if err != nil || len(primary.ConnectionString) == 0 {
		return false
	}
	CmdSuggestion = ipv6PoolerSuggestion(primary.ConnectionString)
	return true
}

// Sets CmdSuggestion to an actionable hint based on the given pg connection error.
func SetConnectSuggestion(err error) {
	if err == nil {
		return
	}
	msg := err.Error()
	if strings.Contains(msg, "connect: connection refused") ||
		strings.Contains(msg, "Address not in tenant allow_list") {
		CmdSuggestion = fmt.Sprintf(
			"Make sure your local IP is allowed in Network Restrictions and Network Bans.\n%s/project/_/database/settings",
			CurrentProfile.DashboardURL,
		)
	} else if strings.Contains(msg, "SSL connection is required") && viper.GetBool("DEBUG") {
		CmdSuggestion = "SSL connection is not supported with --debug flag"
	} else if strings.Contains(msg, "SCRAM exchange: Wrong password") || strings.Contains(msg, "failed SASL auth") {
		// password authentication failed for user / invalid SCRAM server-final-message received from server
		CmdSuggestion = SuggestEnvVar
	} else if isIPv6ConnectivityError(msg) {
		CmdSuggestion = ipv6Suggestion()
	} else if strings.Contains(msg, "connect: no route to host") || strings.Contains(msg, "Tenant or user not found") {
		// Assumes IPv6 check has been performed before this
		CmdSuggestion = "Make sure your project exists on profile: " + CurrentProfile.Name
	}
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
