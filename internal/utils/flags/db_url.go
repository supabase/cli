package flags

import (
	"context"
	"crypto/rand"
	_ "embed"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/cenkalti/backoff/v4"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/spf13/pflag"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/config"
)

type connection int

const (
	unknown connection = iota
	direct
	local
	linked
	proxy
)

var DbConfig pgconn.Config

func ParseDatabaseConfig(ctx context.Context, flagSet *pflag.FlagSet, fsys afero.Fs) error {
	// Changed flags take precedence over default values
	var connType connection
	if flag := flagSet.Lookup("db-url"); flag != nil && flag.Changed {
		connType = direct
	} else if flag := flagSet.Lookup("local"); flag != nil && flag.Changed {
		connType = local
	} else if flag := flagSet.Lookup("linked"); flag != nil && flag.Changed {
		connType = linked
	} else if flag := flagSet.Lookup("proxy"); flag != nil && flag.Changed {
		connType = proxy
	} else if value, err := flagSet.GetBool("local"); err == nil && value {
		connType = local
	} else if value, err := flagSet.GetBool("linked"); err == nil && value {
		connType = linked
	} else if value, err := flagSet.GetBool("proxy"); err == nil && value {
		connType = proxy
	}
	// Update connection config
	switch connType {
	case direct:
		if err := LoadConfig(fsys); err != nil {
			return err
		}
		if flag := flagSet.Lookup("db-url"); flag != nil {
			config, err := pgconn.ParseConfig(flag.Value.String())
			if err != nil {
				return errors.Errorf("failed to parse connection string: %w", err)
			}
			DbConfig = *config
		}
	case local:
		if err := LoadConfig(fsys); err != nil {
			return err
		}
		// Ignore other PG settings
		DbConfig.Host = utils.Config.Hostname
		DbConfig.Port = utils.Config.Db.Port
		DbConfig.User = "postgres"
		DbConfig.Password = utils.Config.Db.Password
		DbConfig.Database = "postgres"
	case linked:
		if err := LoadProjectRef(fsys); err != nil {
			return err
		}
		if err := LoadConfig(fsys); err != nil {
			return err
		}
		var err error
		if DbConfig, err = NewDbConfigWithPassword(ctx, ProjectRef); err != nil {
			return err
		}
	case proxy:
		token, err := utils.LoadAccessTokenFS(fsys)
		if err != nil {
			return err
		}
		if err := LoadProjectRef(fsys); err != nil {
			return err
		}
		DbConfig.Host = utils.GetSupabaseAPIHost()
		DbConfig.Port = 443
		DbConfig.User = "postgres"
		DbConfig.Password = token
		DbConfig.Database = ProjectRef
	}
	return nil
}

const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

func RandomString(size int) (string, error) {
	data := make([]byte, size)
	_, err := rand.Read(data)
	if err != nil {
		return "", errors.Errorf("failed to read random: %w", err)
	}
	for i := range data {
		n := int(data[i]) % len(letters)
		data[i] = letters[n]
	}
	return string(data), nil
}

const suggestEnvVar = "Connect to your database by setting the env var: SUPABASE_DB_PASSWORD"

func NewDbConfigWithPassword(ctx context.Context, projectRef string) (pgconn.Config, error) {
	config := pgconn.Config{
		Host:     utils.GetSupabaseDbHost(projectRef),
		Port:     5432,
		User:     "postgres",
		Password: viper.GetString("DB_PASSWORD"),
		Database: "postgres",
	}
	logger := utils.GetDebugLogger()
	// Use pooler if host is not reachable directly
	d := net.Dialer{Timeout: 5 * time.Second}
	addr := fmt.Sprintf("%s:%d", config.Host, config.Port)
	if conn, err := d.DialContext(ctx, "tcp", addr); err == nil {
		if err := conn.Close(); err != nil {
			fmt.Fprintln(logger, err)
		}
		fmt.Fprintf(logger, "Resolved DNS: %v\n", conn.RemoteAddr())
	} else if poolerConfig := utils.GetPoolerConfig(projectRef); poolerConfig != nil {
		if len(config.Password) > 0 {
			fmt.Fprintln(logger, "Using database password from env var...")
			poolerConfig.Password = config.Password
		} else if err := initPoolerLogin(ctx, projectRef, poolerConfig); err != nil {
			utils.CmdSuggestion = suggestEnvVar
			return *poolerConfig, err
		}
		return *poolerConfig, nil
	} else {
		utils.CmdSuggestion = fmt.Sprintf("Run %s to setup IPv4 connection.", utils.Aqua("supabase link --project-ref "+projectRef))
		return config, errors.Errorf("IPv6 is not supported on your current network: %w", err)
	}
	// Connect via direct connection
	if len(config.Password) > 0 {
		fmt.Fprintln(logger, "Using database password from env var...")
	} else if err := initLoginRole(ctx, projectRef, &config); err != nil {
		// Do not prompt because reading masked input is buggy on windows
		utils.CmdSuggestion = suggestEnvVar
		return config, err
	}
	return config, nil
}

func initLoginRole(ctx context.Context, projectRef string, config *pgconn.Config) error {
	fmt.Fprintln(os.Stderr, "Initialising login role...")
	body := api.CreateRoleBody{ReadOnly: false}
	resp, err := utils.GetSupabase().V1CreateLoginRoleWithResponse(ctx, projectRef, body)
	if err != nil {
		return errors.Errorf("failed to initialise login role: %w", err)
	} else if resp.JSON201 == nil {
		return errors.Errorf("unexpected login role status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	config.User = resp.JSON201.Role
	config.Password = resp.JSON201.Password
	return nil
}

func initPoolerLogin(ctx context.Context, projectRef string, poolerConfig *pgconn.Config) error {
	poolerUser := poolerConfig.User
	if err := initLoginRole(ctx, projectRef, poolerConfig); err != nil {
		return err
	}
	suffix := "." + projectRef
	if strings.HasSuffix(poolerUser, suffix) {
		poolerConfig.User += suffix
	}
	// Wait for pooler to refresh password
	login := func() error {
		conn, err := pgconn.ConnectConfig(ctx, poolerConfig)
		if err != nil {
			return errors.Errorf("failed to connect as temp role: %w", err)
		}
		return conn.Close(ctx)
	}
	notify := utils.NewErrorCallback(func(attempt uint) error {
		if attempt < 3 {
			return nil
		}
		if ips, err := ListNetworkBans(ctx, projectRef); err != nil {
			return err
		} else if len(ips) > 0 {
			return UnbanIP(ctx, projectRef, ips...)
		}
		return nil
	})
	return backoff.RetryNotify(login, utils.NewBackoffPolicy(ctx), notify)
}

func ListNetworkBans(ctx context.Context, projectRef string) ([]string, error) {
	resp, err := utils.GetSupabase().V1ListAllNetworkBansWithResponse(ctx, projectRef)
	if err != nil {
		return nil, errors.Errorf("failed to list network bans: %w", err)
	} else if resp.JSON201 == nil {
		return nil, errors.Errorf("unexpected list bans status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	return resp.JSON201.BannedIpv4Addresses, nil
}

func UnbanIP(ctx context.Context, projectRef string, addrs ...string) error {
	includeSelf := len(addrs) == 0
	body := api.RemoveNetworkBanRequest{
		Ipv4Addresses: append([]string{}, addrs...),
		RequesterIp:   &includeSelf,
	}
	if resp, err := utils.GetSupabase().V1DeleteNetworkBansWithResponse(ctx, projectRef, body); err != nil {
		return errors.Errorf("failed to remove network bans: %w", err)
	} else if resp.StatusCode() != http.StatusOK {
		return errors.Errorf("unexpected unban status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	return nil
}

const PASSWORD_LENGTH = 16

func PromptPassword(stdin *os.File) string {
	fmt.Fprint(os.Stderr, "Enter your database password (or leave blank to generate one): ")
	if input := credentials.PromptMasked(stdin); len(input) > 0 {
		return input
	}
	// Generate a password, see ./Settings/Database/DatabaseSettings/ResetDbPassword.tsx#L83
	var password []byte
	charset := string(config.LowerUpperLettersDigits.ToChar())
	charset = strings.ReplaceAll(charset, ":", "")
	maxRange := big.NewInt(int64(len(charset)))
	for range PASSWORD_LENGTH {
		random, err := rand.Int(rand.Reader, maxRange)
		if err != nil {
			fmt.Fprintln(os.Stderr, "Failed to randomise password:", err)
			continue
		}
		password = append(password, charset[random.Int64()])
	}
	return string(password)
}
