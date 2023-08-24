package status

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"reflect"

	"github.com/docker/docker/client"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

type CustomName struct {
	ApiURL         string `env:"api.url,default=API_URL"`
	GraphqlURL     string `env:"api.graphql_url,default=GRAPHQL_URL"`
	DbURL          string `env:"db.url,default=DB_URL"`
	StudioURL      string `env:"studio.url,default=STUDIO_URL"`
	InbucketURL    string `env:"inbucket.url,default=INBUCKET_URL"`
	JWTSecret      string `env:"auth.jwt_secret,default=JWT_SECRET"`
	AnonKey        string `env:"auth.anon_key,default=ANON_KEY"`
	ServiceRoleKey string `env:"auth.service_role_key,default=SERVICE_ROLE_KEY"`
}

func (c *CustomName) toValues(exclude ...string) map[string]string {
	values := map[string]string{
		c.DbURL: fmt.Sprintf("postgresql://postgres:%s@localhost:%d/postgres", utils.Config.Db.Password, utils.Config.Db.Port),
	}
	if utils.Config.Api.Enabled && !utils.SliceContains(exclude, utils.RestId) && !utils.SliceContains(exclude, utils.ShortContainerImageName(utils.PostgrestImage)) {
		values[c.ApiURL] = fmt.Sprintf("http://localhost:%d", utils.Config.Api.Port)
		values[c.GraphqlURL] = fmt.Sprintf("http://localhost:%d/graphql/v1", utils.Config.Api.Port)
	}
	if utils.Config.Studio.Enabled && !utils.SliceContains(exclude, utils.StudioId) && !utils.SliceContains(exclude, utils.ShortContainerImageName(utils.StudioImage)) {
		values[c.StudioURL] = fmt.Sprintf("http://localhost:%d", utils.Config.Studio.Port)
	}
	if !utils.SliceContains(exclude, utils.GotrueId) && !utils.SliceContains(exclude, utils.ShortContainerImageName(utils.GotrueImage)) {
		values[c.JWTSecret] = utils.Config.Auth.JwtSecret
		values[c.AnonKey] = utils.Config.Auth.AnonKey
		values[c.ServiceRoleKey] = utils.Config.Auth.ServiceRoleKey
	}
	if utils.Config.Inbucket.Enabled && !utils.SliceContains(exclude, utils.InbucketId) && !utils.SliceContains(exclude, utils.ShortContainerImageName(utils.InbucketImage)) {
		values[c.InbucketURL] = fmt.Sprintf("http://localhost:%d", utils.Config.Inbucket.Port)
	}
	return values
}

func Run(ctx context.Context, names CustomName, format string, fsys afero.Fs) error {
	// Sanity checks.
	{
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}
		if err := AssertContainerHealthy(ctx, utils.DbId); err != nil {
			return err
		}
	}

	services := []string{
		utils.KongId,
		utils.GotrueId,
		utils.InbucketId,
		utils.RealtimeId,
		utils.RestId,
		utils.StorageId,
		utils.ImgProxyId,
		utils.PgmetaId,
		utils.StudioId,
		utils.LogflareId,
	}
	stopped := checkServiceHealth(ctx, services, os.Stderr)
	if len(stopped) > 0 {
		fmt.Fprintln(os.Stderr, "Stopped services:", stopped)
	}
	if format == utils.OutputPretty {
		fmt.Fprintf(os.Stderr, "%s local development setup is running.\n\n", utils.Aqua("supabase"))
		PrettyPrint(os.Stdout, stopped...)
		return nil
	}
	return printStatus(names, format, os.Stdout, stopped...)
}

func checkServiceHealth(ctx context.Context, services []string, w io.Writer) (stopped []string) {
	for _, name := range services {
		if err := AssertContainerHealthy(ctx, name); err != nil {
			if client.IsErrNotFound(err) {
				stopped = append(stopped, name)
			} else {
				// Log unhealthy containers instead of failing
				fmt.Fprintln(w, err)
			}
		}
	}
	return stopped
}

func AssertContainerHealthy(ctx context.Context, container string) error {
	if resp, err := utils.Docker.ContainerInspect(ctx, container); err != nil {
		return err
	} else if !resp.State.Running {
		return fmt.Errorf("%s container is not running: %s", container, resp.State.Status)
	} else if resp.State.Health != nil && resp.State.Health.Status != "healthy" {
		return fmt.Errorf("%s container is not ready: %s", container, resp.State.Health.Status)
	}
	return nil
}

func IsServiceReady(ctx context.Context, container string) bool {
	if container == utils.RestId {
		return isPostgRESTHealthy(ctx)
	}
	if container == utils.EdgeRuntimeId {
		return isEdgeRuntimeHealthy(ctx)
	}
	return AssertContainerHealthy(ctx, container) == nil
}

func isPostgRESTHealthy(ctx context.Context) bool {
	// PostgREST does not support native health checks
	restUrl := fmt.Sprintf("http://localhost:%d/rest/v1/", utils.Config.Api.Port)
	return checkHTTPHead(ctx, restUrl)
}

func isEdgeRuntimeHealthy(ctx context.Context) bool {
	// Native health check logs too much hyper::Error(IncompleteMessage)
	restUrl := fmt.Sprintf("http://localhost:%d/functions/v1/_internal/health", utils.Config.Api.Port)
	return checkHTTPHead(ctx, restUrl)
}

func checkHTTPHead(ctx context.Context, url string) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, url, nil)
	if err != nil {
		return false
	}
	req.Header.Add("apikey", utils.Config.Auth.AnonKey)
	resp, err := http.DefaultClient.Do(req)
	return err == nil && resp.StatusCode == http.StatusOK
}

func printStatus(names CustomName, format string, w io.Writer, exclude ...string) (err error) {
	values := names.toValues(exclude...)

	return utils.EncodeOutput(format, w, values)
}

func PrettyPrint(w io.Writer, exclude ...string) {
	names := CustomName{
		ApiURL:         "         " + utils.Aqua("API URL"),
		GraphqlURL:     "     " + utils.Aqua("GraphQL URL"),
		DbURL:          "          " + utils.Aqua("DB URL"),
		StudioURL:      "      " + utils.Aqua("Studio URL"),
		InbucketURL:    "    " + utils.Aqua("Inbucket URL"),
		JWTSecret:      "      " + utils.Aqua("JWT secret"),
		AnonKey:        "        " + utils.Aqua("anon key"),
		ServiceRoleKey: "" + utils.Aqua("service_role key"),
	}
	values := names.toValues(exclude...)
	// Iterate through map in order of declared struct fields
	val := reflect.ValueOf(names)
	for i := 0; i < val.NumField(); i++ {
		k := val.Field(i).String()
		if v, ok := values[k]; ok {
			fmt.Fprintf(w, "%s: %s\n", k, v)
		}
	}
}
