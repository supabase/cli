package flags

import (
	"bytes"
	"context"
	"crypto/rand"
	_ "embed"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"strings"
	"text/template"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/spf13/pflag"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/config"
	"github.com/supabase/cli/pkg/pgxv5"
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
	var err error
	if config.Password, err = RandomString(32); err == nil {
		newRole := pgconn.Config{
			User:     pgxv5.CLI_LOGIN_ROLE,
			Password: config.Password,
		}
		if err := initLoginRole(ctx, projectRef, newRole); err == nil {
			// Special handling for pooler username
			if suffix := "." + projectRef; strings.HasSuffix(config.User, suffix) {
				newRole.User += suffix
			}
			config.User = newRole.User
			return config
		}
	}
	if config.Password, err = credentials.StoreProvider.Get(projectRef); err == nil {
		return config
	}
	resetUrl := fmt.Sprintf("%s/project/%s/settings/database", utils.GetSupabaseDashboardURL(), projectRef)
	fmt.Fprintln(os.Stderr, "Forgot your password? Reset it from the Dashboard:", utils.Bold(resetUrl))
	fmt.Fprint(os.Stderr, "Enter your database password: ")
	config.Password = credentials.PromptMasked(os.Stdin)
	return config
}

var (
	//go:embed queries/role.sql
	initRoleEmbed    string
	initRoleTemplate = template.Must(template.New("initRole").Parse(initRoleEmbed))
)

func initLoginRole(ctx context.Context, projectRef string, config pgconn.Config) error {
	fmt.Fprintf(os.Stderr, "Initialising %s role...\n", config.User)
	var initRoleBuf bytes.Buffer
	if err := initRoleTemplate.Option("missingkey=error").Execute(&initRoleBuf, config); err != nil {
		return errors.Errorf("failed to exec template: %w", err)
	}
	body := api.V1RunQueryBody{Query: initRoleBuf.String()}
	if resp, err := utils.GetSupabase().V1RunAQueryWithResponse(ctx, projectRef, body); err != nil {
		return errors.Errorf("failed to initialise login role: %w", err)
	} else if resp.StatusCode() != http.StatusCreated {
		return errors.Errorf("unexpected query status %d: %s", resp.StatusCode(), string(resp.Body))
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
