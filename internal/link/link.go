package link

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/BurntSushi/toml"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/supabase/cli/pkg/api"
)

var (
	updatedConfig       = make(map[string]interface{})
	errMissingKeys      = errors.New("No API keys found.")
	errGotrueVersion    = errors.New("GoTrue version not found.")
	errPostgrestVersion = errors.New("PostgREST version not found.")
)

func PreRun(projectRef string, fsys afero.Fs) error {
	// Sanity checks
	if err := utils.AssertProjectRefIsValid(projectRef); err != nil {
		return err
	}
	return utils.LoadConfigFS(fsys)
}

func Run(ctx context.Context, projectRef, password string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	// 1. Check service config
	if err := loadAnonKey(ctx, projectRef); err != nil {
		return err
	}
	// Ignore non-fatal errors linking services
	if err := linkPostgrest(ctx, projectRef, fsys); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
	if err := linkGotrue(ctx, projectRef, fsys); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
	if err := linkPooler(ctx, projectRef); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}

	// 2. Check database connection
	if len(password) > 0 {
		if err := linkDatabase(ctx, pgconn.Config{
			Host:     utils.GetSupabaseDbHost(projectRef),
			Port:     6543,
			User:     "postgres",
			Password: password,
			Database: "postgres",
		}, options...); err != nil {
			return err
		}
		// Save database password
		if err := credentials.Set(projectRef, password); err != nil {
			fmt.Fprintln(os.Stderr, "Failed to save database password:", err)
		}
	}

	// 3. Save project ref
	if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(utils.ProjectRefPath)); err != nil {
		return err
	}
	return afero.WriteFile(fsys, utils.ProjectRefPath, []byte(projectRef), 0644)
}

func PostRun(projectRef string, stdout io.Writer, fsys afero.Fs) error {
	fmt.Fprintln(stdout, "Finished "+utils.Aqua("supabase link")+".")
	if len(updatedConfig) == 0 {
		return nil
	}
	fmt.Fprintln(os.Stderr, "Local config differs from linked project. Try updating", utils.Bold(utils.ConfigPath))
	enc := toml.NewEncoder(stdout)
	enc.Indent = ""
	return enc.Encode(updatedConfig)
}

func linkPostgrest(ctx context.Context, projectRef string, fsys afero.Fs) error {
	resp, err := utils.GetSupabase().GetPostgRESTConfigWithResponse(ctx, projectRef)
	if err != nil {
		return err
	}
	if resp.JSON200 == nil {
		return errors.New("Authorization failed for the access token and project ref pair: " + string(resp.Body))
	}
	updateApiConfig(*resp.JSON200)
	url := fmt.Sprintf("https://%s/rest/v1/", utils.GetSupabaseHost(projectRef))
	data, err := getJsonResponse[SwaggerResponse](ctx, url, utils.Config.Auth.AnonKey)
	if err != nil {
		return err
	}
	return updatePostgrestVersion(ctx, data.Info.Version, fsys)
}

func updateApiConfig(config api.PostgrestConfigWithJWTSecretResponse) {
	copy := utils.Config.Api
	copy.MaxRows = uint(config.MaxRows)
	copy.ExtraSearchPath = readCsv(config.DbExtraSearchPath)
	copy.Schemas = readCsv(config.DbSchema)
	changed := utils.Config.Api.MaxRows != copy.MaxRows ||
		!utils.SliceEqual(utils.Config.Api.ExtraSearchPath, copy.ExtraSearchPath) ||
		!utils.SliceEqual(utils.Config.Api.Schemas, copy.Schemas)
	if changed {
		updatedConfig["api"] = copy
	}
}

func readCsv(line string) []string {
	var result []string
	tokens := strings.Split(line, ",")
	for _, t := range tokens {
		trimmed := strings.TrimSpace(t)
		if len(trimmed) > 0 {
			result = append(result, trimmed)
		}
	}
	return result
}

type SwaggerInfo struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Version     string `json:"version"`
}

type SwaggerResponse struct {
	Swagger string      `json:"swagger"`
	Info    SwaggerInfo `json:"info"`
}

func updatePostgrestVersion(ctx context.Context, version string, fsys afero.Fs) error {
	if len(version) == 0 {
		return errPostgrestVersion
	}
	if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(utils.RestVersionPath)); err != nil {
		return err
	}
	return afero.WriteFile(fsys, utils.RestVersionPath, []byte("v"+version), 0644)
}

func loadAnonKey(ctx context.Context, projectRef string) error {
	resp, err := utils.GetSupabase().GetProjectApiKeysWithResponse(ctx, projectRef)
	if err != nil {
		return err
	}
	if resp.JSON200 == nil {
		return errors.New("Authorization failed for the access token and project ref pair: " + string(resp.Body))
	}
	keys := *resp.JSON200
	if len(keys) == 0 {
		return errMissingKeys
	}
	utils.Config.Auth.AnonKey = keys[0].ApiKey
	return nil
}

func linkGotrue(ctx context.Context, projectRef string, fsys afero.Fs) error {
	url := fmt.Sprintf("https://%s/auth/v1/health", utils.GetSupabaseHost(projectRef))
	data, err := getJsonResponse[HealthResponse](ctx, url, utils.Config.Auth.AnonKey)
	if err != nil {
		return err
	}
	return updateGotrueVersion(ctx, data.Version, fsys)
}

type HealthResponse struct {
	Version     string `json:"version"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

func getJsonResponse[T any](ctx context.Context, url, apiKey string) (*T, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Add("apikey", apiKey)
	// Sends request
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, err := io.ReadAll(resp.Body)
		if err != nil || len(body) == 0 {
			body = []byte(fmt.Sprintf("Error status %d", resp.StatusCode))
		}
		return nil, errors.New(string(body))
	}
	// Parses response
	var data T
	dec := json.NewDecoder(resp.Body)
	if err := dec.Decode(&data); err != nil {
		return nil, err
	}
	return &data, nil
}

func updateGotrueVersion(ctx context.Context, version string, fsys afero.Fs) error {
	if len(version) == 0 {
		return errGotrueVersion
	}
	if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(utils.GotrueVersionPath)); err != nil {
		return err
	}
	return afero.WriteFile(fsys, utils.GotrueVersionPath, []byte(version), 0644)
}

func linkDatabase(ctx context.Context, config pgconn.Config, options ...func(*pgx.ConnConfig)) error {
	conn, err := utils.ConnectRemotePostgres(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	updatePostgresConfig(conn)
	// If `schema_migrations` doesn't exist on the remote database, create it.
	return repair.CreateMigrationTable(ctx, conn)
}

func updatePostgresConfig(conn *pgx.Conn) {
	serverVersion := conn.PgConn().ParameterStatus("server_version")
	// Safe to assume that supported Postgres version is 10.0 <= n < 100.0
	majorDigits := len(serverVersion)
	if majorDigits > 2 {
		majorDigits = 2
	}
	dbMajorVersion, err := strconv.ParseUint(serverVersion[:majorDigits], 10, 7)
	// Treat error as unchanged
	if err == nil && uint64(utils.Config.Db.MajorVersion) != dbMajorVersion {
		copy := utils.Config.Db
		copy.MajorVersion = uint(dbMajorVersion)
		updatedConfig["db"] = copy
	}
}

func linkPooler(ctx context.Context, projectRef string) error {
	resp, err := utils.GetSupabase().V1GetPgbouncerConfigWithResponse(ctx, projectRef)
	if err != nil {
		return err
	}
	if resp.JSON200 == nil {
		return errors.New("Authorization failed for the access token and project ref pair: " + string(resp.Body))
	}
	updatePoolerConfig(*resp.JSON200)
	return nil
}

func updatePoolerConfig(config api.V1PgbouncerConfigResponse) {
	copy := utils.Config.Db.Pooler
	if config.PoolMode != nil {
		copy.PoolMode = utils.PoolMode(*config.PoolMode)
	}
	if config.DefaultPoolSize != nil {
		copy.DefaultPoolSize = uint(*config.DefaultPoolSize)
	}
	if config.MaxClientConn != nil {
		copy.MaxClientConn = uint(*config.MaxClientConn)
	}
	changed := utils.Config.Db.Pooler.PoolMode != copy.PoolMode ||
		utils.Config.Db.Pooler.DefaultPoolSize != copy.DefaultPoolSize ||
		utils.Config.Db.Pooler.MaxClientConn != copy.MaxClientConn
	if changed {
		updatedConfig["db.pooler"] = copy
	}
}

func PromptPassword(stdin *os.File) string {
	fmt.Fprint(os.Stderr, "Enter your database password: ")
	return credentials.PromptMasked(stdin)
}

func PromptPasswordAllowBlank(stdin *os.File) string {
	fmt.Fprint(os.Stderr, "Enter your database password (or leave blank to skip): ")
	return credentials.PromptMasked(stdin)
}
