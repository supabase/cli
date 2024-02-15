package flags

import (
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/spf13/pflag"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
)

type connection int

const (
	direct connection = iota
	local
	linked
	proxy
)

var DbConfig pgconn.Config

func ParseDatabaseConfig(flagSet *pflag.FlagSet, fsys afero.Fs) error {
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
		if flag := flagSet.Lookup("db-url"); flag != nil {
			config, err := pgconn.ParseConfig(flag.Value.String())
			if err != nil {
				return errors.Errorf("failed to parse connection string: %w", err)
			}
			DbConfig = *config
		}
	case local:
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}
		// Ignore other PG settings
		DbConfig.Host = utils.Config.Hostname
		DbConfig.Port = uint16(utils.Config.Db.Port)
		DbConfig.User = "postgres"
		DbConfig.Password = utils.Config.Db.Password
		DbConfig.Database = "postgres"
	case linked:
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}
		projectRef, err := LoadProjectRef(fsys)
		if err != nil {
			return err
		}
		DbConfig = newDbConfigWithPassword(projectRef)
	case proxy:
		token, err := utils.LoadAccessTokenFS(fsys)
		if err != nil {
			return err
		}
		projectRef, err := LoadProjectRef(fsys)
		if err != nil {
			return err
		}
		DbConfig.Host = utils.GetSupabaseAPIHost()
		DbConfig.Port = 443
		DbConfig.User = "postgres"
		DbConfig.Password = token
		DbConfig.Database = projectRef
	}
	return nil
}

func newDbConfigWithPassword(projectRef string) pgconn.Config {
	config := getDbConfig(projectRef)
	config.Password = getPassword(projectRef)
	return config
}

func getPassword(projectRef string) string {
	if password := viper.GetString("DB_PASSWORD"); len(password) > 0 {
		return password
	}
	if password, err := credentials.Get(projectRef); err == nil {
		return password
	}
	return PromptPassword(os.Stdin)
}

func PromptPassword(stdin *os.File) string {
	fmt.Fprint(os.Stderr, "Enter your database password: ")
	return credentials.PromptMasked(stdin)
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

func GetDbConfigOptionalPassword(projectRef string) pgconn.Config {
	config := getDbConfig(projectRef)
	config.Password = viper.GetString("DB_PASSWORD")
	if config.Password == "" {
		fmt.Fprint(os.Stderr, "Enter your database password (or leave blank to skip): ")
		config.Password = credentials.PromptMasked(os.Stdin)
	}
	return config
}
