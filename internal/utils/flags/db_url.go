package flags

import (
	"context"
	"crypto/rand"
	_ "embed"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"strings"

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
		DbConfig = NewDbConfigWithPassword(ctx, ProjectRef)
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

func NewDbConfigWithPassword(ctx context.Context, projectRef string) pgconn.Config {
	config := getDbConfig(projectRef)
	config.Password = viper.GetString("DB_PASSWORD")
	if len(config.Password) > 0 {
		return config
	}
	loginRole, err := initLoginRole(ctx, projectRef, config)
	if err == nil {
		return loginRole
	}
	// Proceed with password prompt
	fmt.Fprintln(utils.GetDebugLogger(), err)
	if config.Password, err = credentials.StoreProvider.Get(projectRef); err == nil {
		return config
	}
	resetUrl := fmt.Sprintf("%s/project/%s/settings/database", utils.GetSupabaseDashboardURL(), projectRef)
	fmt.Fprintln(os.Stderr, "Forgot your password? Reset it from the Dashboard:", utils.Bold(resetUrl))
	fmt.Fprint(os.Stderr, "Enter your database password: ")
	config.Password = credentials.PromptMasked(os.Stdin)
	return config
}

func initLoginRole(ctx context.Context, projectRef string, config pgconn.Config) (pgconn.Config, error) {
	fmt.Fprintln(os.Stderr, "Initialising login role...")
	body := api.CreateRoleBody{ReadOnly: false}
	resp, err := utils.GetSupabase().V1CreateLoginRoleWithResponse(ctx, projectRef, body)
	if err != nil {
		return pgconn.Config{}, errors.Errorf("failed to initialise login role: %w", err)
	} else if resp.JSON201 == nil {
		return pgconn.Config{}, errors.Errorf("unexpected login role status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	// Direct connection can be tried immediately
	suffix := "." + projectRef
	if !strings.HasSuffix(config.User, suffix) {
		config.User = resp.JSON201.Role
		config.Password = resp.JSON201.Password
		return config, nil
	}
	// Wait for pooler to refresh password
	config.User = resp.JSON201.Role + suffix
	config.Password = resp.JSON201.Password
	login := func() error {
		conn, err := pgconn.ConnectConfig(ctx, &config)
		if err != nil {
			return errors.Errorf("failed to connect as temp role: %w", err)
		}
		return conn.Close(ctx)
	}
	// Fallback to password prompt on error
	notify := utils.NewErrorCallback(func(attempt uint) error {
		if attempt%3 > 0 {
			return nil
		}
		return UnbanIP(ctx, projectRef)
	})
	if err := backoff.RetryNotify(login, utils.NewBackoffPolicy(ctx), notify); err != nil {
		return pgconn.Config{}, err
	}
	return config, nil
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
	for i := 0; i < PASSWORD_LENGTH; i++ {
		random, err := rand.Int(rand.Reader, maxRange)
		if err != nil {
			fmt.Fprintln(os.Stderr, "Failed to randomise password:", err)
			continue
		}
		password = append(password, charset[random.Int64()])
	}
	return string(password)
}

func getDbConfig(projectRef string) pgconn.Config {
	if poolerConfig := utils.GetPoolerConfig(projectRef); poolerConfig != nil {
		return *poolerConfig
	}
	return pgconn.Config{
		Host:     utils.GetSupabaseDbHost(projectRef),
		Port:     5432,
		User:     "postgres",
		Database: "postgres",
	}
}
