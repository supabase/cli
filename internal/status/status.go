package status

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/BurntSushi/toml"
	"github.com/joho/godotenv"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"gopkg.in/yaml.v3"
)

const (
	OutputEnv    = "env"
	OutputJson   = "json"
	OutputPretty = "pretty"
	OutputToml   = "toml"
	OutputYaml   = "yaml"
)

type CustomName struct {
	ApiURL         string `env:"api.url,default=API_URL"`
	DbURL          string `env:"db.url,default=DB_URL"`
	StudioURL      string `env:"studio.url,default=STUDIO_URL"`
	InbucketURL    string `env:"inbucket.url,default=INBUCKET_URL"`
	AnonKey        string `env:"auth.anon_key,default=ANON_KEY"`
	ServiceRoleKey string `env:"auth.service_role_key,default=SERVICE_ROLE_KEY"`
}

func (c *CustomName) toValues() map[string]string {
	return map[string]string{
		c.ApiURL:         fmt.Sprintf("http://localhost:%d", utils.Config.Api.Port),
		c.DbURL:          fmt.Sprintf("postgresql://postgres:postgres@localhost:%d/postgres", utils.Config.Db.Port),
		c.StudioURL:      fmt.Sprintf("http://localhost:%d", utils.Config.Studio.Port),
		c.InbucketURL:    fmt.Sprintf("http://localhost:%d", utils.Config.Inbucket.Port),
		c.AnonKey:        utils.AnonKey,
		c.ServiceRoleKey: utils.ServiceRoleKey,
	}
}

func Run(ctx context.Context, names CustomName, format string, fsys afero.Fs) error {
	// Sanity checks.
	{
		if err := utils.AssertSupabaseCliIsSetUpFS(fsys); err != nil {
			return err
		}
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}
		if err := utils.AssertDockerIsRunning(); err != nil {
			return err
		}
	}

	services := []string{
		utils.DbId,
		utils.KongId,
		utils.GotrueId,
		utils.InbucketId,
		utils.RealtimeId,
		utils.RestId,
		utils.StorageId,
		utils.PgmetaId,
		utils.StudioId,
	}
	if err := checkServiceHealth(ctx, services, os.Stderr); err != nil {
		return err
	}
	return printStatus(names.toValues(), format, os.Stdout)
}

func checkServiceHealth(ctx context.Context, services []string, w io.Writer) error {
	for _, name := range services {
		resp, err := utils.Docker.ContainerInspect(ctx, name)
		if err != nil {
			return fmt.Errorf("%s container not found. Have you run %s?", name, utils.Aqua("supabase start"))
		}
		if !resp.State.Running {
			fmt.Fprintln(w, name, "container is not running:", resp.State.Status)
		}
	}
	return nil
}

func printStatus(values map[string]string, format string, w io.Writer) (err error) {
	switch format {
	case OutputEnv:
		var out string
		out, err = godotenv.Marshal(values)
		fmt.Fprintln(w, out)
	case OutputJson:
		enc := json.NewEncoder(w)
		err = enc.Encode(values)
	case OutputYaml:
		enc := yaml.NewEncoder(w)
		err = enc.Encode(values)
	case OutputToml:
		enc := toml.NewEncoder(w)
		err = enc.Encode(values)
	default:
		fmt.Fprintln(os.Stderr, utils.Aqua("supabase"), "local development setup is running.")
		utils.ShowStatus()
	}
	return err
}
