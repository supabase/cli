package types

import (
	"context"
	_ "embed"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

const (
	LangTypescript = "typescript"
	LangGo         = "go"
	LangSwift      = "swift"
	LangPython     = "python"
)

const (
	SwiftPublicAccessControl   = "public"
	SwiftInternalAccessControl = "internal"
)

func Run(ctx context.Context, projectId string, dbConfig pgconn.Config, lang string, schemas []string, postgrestV9Compat bool, swiftAccessControl string, queryTimeout time.Duration, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	originalURL := utils.ToPostgresURL(dbConfig)
	// Add default schemas if --schema flag is not specified
	if len(schemas) == 0 {
		schemas = utils.RemoveDuplicates(append([]string{"public"}, utils.Config.Api.Schemas...))
	}
	included := strings.Join(schemas, ",")

	if projectId != "" {
		if lang != LangTypescript {
			return errors.Errorf("Unable to generate %s types for selected project. Try using --db-url flag instead.", lang)
		}
		resp, err := utils.GetSupabase().V1GenerateTypescriptTypesWithResponse(ctx, projectId, &api.V1GenerateTypescriptTypesParams{
			IncludedSchemas: &included,
		})
		if err != nil {
			return errors.Errorf("failed to get typescript types: %w", err)
		}

		if resp.JSON200 == nil {
			return errors.New("failed to retrieve generated types: " + string(resp.Body))
		}

		fmt.Print(resp.JSON200.Types)
		return nil
	}

	hostConfig := container.HostConfig{}
	if utils.IsLocalDatabase(dbConfig) {
		if err := utils.AssertSupabaseDbIsRunning(); err != nil {
			return err
		}

		if strings.Contains(utils.Config.Api.Image, "v9") {
			postgrestV9Compat = true
		}

		// Use custom network when connecting to local database
		dbConfig.Host = utils.DbAliases[0]
		dbConfig.Port = 5432
	} else {
		hostConfig.NetworkMode = network.NetworkHost
	}
	// pg-meta does not set username as the default database, ie. postgres
	if len(dbConfig.Database) == 0 {
		dbConfig.Database = "postgres"
	}

	fmt.Fprintln(os.Stderr, "Connecting to", dbConfig.Host, dbConfig.Port)
	env := []string{
		"PG_META_DB_URL=" + utils.ToPostgresURL(dbConfig),
		fmt.Sprintf("PG_CONN_TIMEOUT_SECS=%.0f", queryTimeout.Seconds()),
		fmt.Sprintf("PG_QUERY_TIMEOUT_SECS=%.0f", queryTimeout.Seconds()),
		"PG_META_GENERATE_TYPES=" + lang,
		"PG_META_GENERATE_TYPES_INCLUDED_SCHEMAS=" + included,
		"PG_META_GENERATE_TYPES_SWIFT_ACCESS_CONTROL=" + swiftAccessControl,
		fmt.Sprintf("PG_META_GENERATE_TYPES_DETECT_ONE_TO_ONE_RELATIONSHIPS=%v", !postgrestV9Compat),
	}
	if ca, err := GetRootCA(ctx, originalURL, options...); err != nil {
		return err
	} else if len(ca) > 0 {
		env = append(env, "PG_META_DB_SSL_ROOT_CERT="+ca)
	}

	return utils.DockerRunOnceWithConfig(
		ctx,
		container.Config{
			Image: utils.Config.Studio.PgmetaImage,
			Env:   env,
			Cmd:   []string{"node", "dist/server/server.js"},
		},
		hostConfig,
		network.NetworkingConfig{},
		"",
		os.Stdout,
		os.Stderr,
	)
}

var (
	//go:embed templates/staging-ca-2021.crt
	caStaging string
	//go:embed templates/prod-ca-2021.crt
	caProd string
	//go:embed templates/prod-ca-2025.crt
	caSnap string
)

func GetRootCA(ctx context.Context, dbURL string, options ...func(*pgx.ConnConfig)) (string, error) {
	// node-postgres does not support sslmode=prefer
	if require, err := isRequireSSL(ctx, dbURL, options...); !require {
		return "", err
	}
	// Merge all certs to support --db-url flag
	return caStaging + caProd + caSnap, nil
}

func isRequireSSL(ctx context.Context, dbUrl string, options ...func(*pgx.ConnConfig)) (bool, error) {

	// pgx v4's sslmode=require verifies the server certificate against system CAs,
	// unlike libpq where require skips verification. When SUPABASE_CA_SKIP_VERIFY=true,
	// skip verification for this probe only (detects whether the server speaks TLS).
	// Cert validation happens downstream in the migra/pgdelta Deno scripts using GetRootCA.
	opts := options
	if os.Getenv("SUPABASE_CA_SKIP_VERIFY") == "true" {
		opts = append(opts, func(cc *pgx.ConnConfig) {
			if cc.TLSConfig != nil {
				// #nosec G402 -- Intentionally skipped for this TLS capability probe only.
				// Downstream migra/pgdelta flows still validate certificates using GetRootCA.
				cc.TLSConfig.InsecureSkipVerify = true
			}
		})
	}
	conn, err := utils.ConnectByUrl(ctx, dbUrl+"&sslmode=require", opts...)
	if err != nil {
		if strings.HasSuffix(err.Error(), "(server refused TLS connection)") {
			return false, nil
		}
		return false, err
	}
	// SSL is not supported in debug mode
	return !viper.GetBool("DEBUG"), conn.Close(ctx)
}
