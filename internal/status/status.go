package status

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	_ "embed"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"sync"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/fetcher"
)

type CustomName struct {
	ApiURL                   string `env:"api.url,default=API_URL"`
	GraphqlURL               string `env:"api.graphql_url,default=GRAPHQL_URL"`
	StorageS3URL             string `env:"api.storage_s3_url,default=STORAGE_S3_URL"`
	DbURL                    string `env:"db.url,default=DB_URL"`
	StudioURL                string `env:"studio.url,default=STUDIO_URL"`
	InbucketURL              string `env:"inbucket.url,default=INBUCKET_URL"`
	JWTSecret                string `env:"auth.jwt_secret,default=JWT_SECRET"`
	AnonKey                  string `env:"auth.anon_key,default=ANON_KEY"`
	ServiceRoleKey           string `env:"auth.service_role_key,default=SERVICE_ROLE_KEY"`
	StorageS3AccessKeyId     string `env:"storage.s3_access_key_id,default=S3_PROTOCOL_ACCESS_KEY_ID"`
	StorageS3SecretAccessKey string `env:"storage.s3_secret_access_key,default=S3_PROTOCOL_ACCESS_KEY_SECRET"`
	StorageS3Region          string `env:"storage.s3_region,default=S3_PROTOCOL_REGION"`
}

func (c *CustomName) toValues(exclude ...string) map[string]string {
	values := map[string]string{
		c.DbURL: fmt.Sprintf("postgresql://%s@%s:%d/postgres", url.UserPassword("postgres", utils.Config.Db.Password), utils.Config.Hostname, utils.Config.Db.Port),
	}
	if utils.Config.Api.Enabled && !utils.SliceContains(exclude, utils.RestId) && !utils.SliceContains(exclude, utils.ShortContainerImageName(utils.Config.Api.Image)) {
		values[c.ApiURL] = utils.Config.Api.ExternalUrl
		values[c.GraphqlURL] = utils.GetApiUrl("/graphql/v1")
	}
	if utils.Config.Studio.Enabled && !utils.SliceContains(exclude, utils.StudioId) && !utils.SliceContains(exclude, utils.ShortContainerImageName(utils.Config.Studio.Image)) {
		values[c.StudioURL] = fmt.Sprintf("http://%s:%d", utils.Config.Hostname, utils.Config.Studio.Port)
	}
	if utils.Config.Auth.Enabled && !utils.SliceContains(exclude, utils.GotrueId) && !utils.SliceContains(exclude, utils.ShortContainerImageName(utils.Config.Auth.Image)) {
		values[c.JWTSecret] = utils.Config.Auth.JwtSecret.Value
		values[c.AnonKey] = utils.Config.Auth.AnonKey.Value
		values[c.ServiceRoleKey] = utils.Config.Auth.ServiceRoleKey.Value
	}
	if utils.Config.Inbucket.Enabled && !utils.SliceContains(exclude, utils.InbucketId) && !utils.SliceContains(exclude, utils.ShortContainerImageName(utils.Config.Inbucket.Image)) {
		values[c.InbucketURL] = fmt.Sprintf("http://%s:%d", utils.Config.Hostname, utils.Config.Inbucket.Port)
	}
	if utils.Config.Storage.Enabled && !utils.SliceContains(exclude, utils.StorageId) && !utils.SliceContains(exclude, utils.ShortContainerImageName(utils.Config.Storage.Image)) {
		values[c.StorageS3URL] = utils.GetApiUrl("/storage/v1/s3")
		values[c.StorageS3AccessKeyId] = utils.Config.Storage.S3Credentials.AccessKeyId
		values[c.StorageS3SecretAccessKey] = utils.Config.Storage.S3Credentials.SecretAccessKey
		values[c.StorageS3Region] = utils.Config.Storage.S3Credentials.Region
	}
	return values
}

func Run(ctx context.Context, names CustomName, format string, fsys afero.Fs) error {
	// Sanity checks.
	if err := flags.LoadConfig(fsys); err != nil {
		return err
	}
	if err := assertContainerHealthy(ctx, utils.DbId); err != nil {
		return err
	}
	stopped, err := checkServiceHealth(ctx)
	if err != nil {
		return err
	}
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

func checkServiceHealth(ctx context.Context) ([]string, error) {
	resp, err := utils.Docker.ContainerList(ctx, container.ListOptions{
		Filters: utils.CliProjectFilter(utils.Config.ProjectId),
	})
	if err != nil {
		return nil, errors.Errorf("failed to list running containers: %w", err)
	}
	running := make(map[string]struct{}, len(resp))
	for _, c := range resp {
		for _, n := range c.Names {
			running[n] = struct{}{}
		}
	}
	var stopped []string
	for _, containerId := range utils.GetDockerIds() {
		if _, ok := running["/"+containerId]; !ok {
			stopped = append(stopped, containerId)
		}
	}
	return stopped, nil
}

func assertContainerHealthy(ctx context.Context, container string) error {
	if resp, err := utils.Docker.ContainerInspect(ctx, container); err != nil {
		return errors.Errorf("failed to inspect container health: %w", err)
	} else if !resp.State.Running {
		return errors.Errorf("%s container is not running: %s", container, resp.State.Status)
	} else if resp.State.Health != nil && resp.State.Health.Status != types.Healthy {
		return errors.Errorf("%s container is not ready: %s", container, resp.State.Health.Status)
	}
	return nil
}

func IsServiceReady(ctx context.Context, container string) error {
	if container == utils.RestId {
		// PostgREST does not support native health checks
		return checkHTTPHead(ctx, "/rest-admin/v1/ready")
	}
	if container == utils.EdgeRuntimeId {
		// Native health check logs too much hyper::Error(IncompleteMessage)
		return checkHTTPHead(ctx, "/functions/v1/_internal/health")
	}
	return assertContainerHealthy(ctx, container)
}

var (
	//go:embed kong.local.crt
	KongCert string
	//go:embed kong.local.key
	KongKey string
)

// To regenerate local certificate pair:
//
//	openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 \
//	  -nodes -keyout kong.local.key -out kong.local.crt -subj "/CN=localhost" \
//	  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
func NewKongClient() *http.Client {
	client := &http.Client{
		Timeout: 10 * time.Second,
	}
	if t, ok := http.DefaultTransport.(*http.Transport); ok {
		pool, err := x509.SystemCertPool()
		if err != nil {
			fmt.Fprintln(utils.GetDebugLogger(), err)
			pool = x509.NewCertPool()
		}
		// No need to replace TLS config if we fail to append cert
		if pool.AppendCertsFromPEM([]byte(KongCert)) {
			rt := t.Clone()
			rt.TLSClientConfig = &tls.Config{
				MinVersion: tls.VersionTLS12,
				RootCAs:    pool,
			}
			client.Transport = rt
		}
	}
	return client
}

var (
	healthClient *fetcher.Fetcher
	healthOnce   sync.Once
)

func checkHTTPHead(ctx context.Context, path string) error {
	healthOnce.Do(func() {
		server := utils.Config.Api.ExternalUrl
		header := func(req *http.Request) {
			req.Header.Add("apikey", utils.Config.Auth.AnonKey.Value)
		}
		client := NewKongClient()
		healthClient = fetcher.NewFetcher(
			server,
			fetcher.WithHTTPClient(client),
			fetcher.WithRequestEditor(header),
			fetcher.WithExpectedStatus(http.StatusOK),
		)
	})
	// HEAD method does not return response body
	resp, err := healthClient.Send(ctx, http.MethodHead, path, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}

func printStatus(names CustomName, format string, w io.Writer, exclude ...string) (err error) {
	values := names.toValues(exclude...)
	return utils.EncodeOutput(format, w, values)
}

func PrettyPrint(w io.Writer, exclude ...string) {
	names := CustomName{
		ApiURL:                   "         " + utils.Aqua("API URL"),
		GraphqlURL:               "     " + utils.Aqua("GraphQL URL"),
		StorageS3URL:             "  " + utils.Aqua("S3 Storage URL"),
		DbURL:                    "          " + utils.Aqua("DB URL"),
		StudioURL:                "      " + utils.Aqua("Studio URL"),
		InbucketURL:              "    " + utils.Aqua("Inbucket URL"),
		JWTSecret:                "      " + utils.Aqua("JWT secret"),
		AnonKey:                  "        " + utils.Aqua("anon key"),
		ServiceRoleKey:           "" + utils.Aqua("service_role key"),
		StorageS3AccessKeyId:     "   " + utils.Aqua("S3 Access Key"),
		StorageS3SecretAccessKey: "   " + utils.Aqua("S3 Secret Key"),
		StorageS3Region:          "       " + utils.Aqua("S3 Region"),
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
