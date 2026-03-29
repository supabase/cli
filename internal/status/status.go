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
	"slices"
	"sync"
	"time"

	"github.com/Netflix/go-env"
	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/go-errors/errors"
	"github.com/olekukonko/tablewriter"
	"github.com/olekukonko/tablewriter/tw"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/fetcher"
)

type CustomName struct {
	ApiURL                   string `env:"api.url,default=API_URL"`
	RestURL                  string `env:"api.rest_url,default=REST_URL"`
	GraphqlURL               string `env:"api.graphql_url,default=GRAPHQL_URL"`
	StorageS3URL             string `env:"api.storage_s3_url,default=STORAGE_S3_URL"`
	McpURL                   string `env:"api.mcp_url,default=MCP_URL"`
	FunctionsURL             string `env:"api.functions_url,default=FUNCTIONS_URL"`
	DbURL                    string `env:"db.url,default=DB_URL"`
	StudioURL                string `env:"studio.url,default=STUDIO_URL"`
	InbucketURL              string `env:"inbucket.url,default=INBUCKET_URL,deprecated"`
	MailpitURL               string `env:"mailpit.url,default=MAILPIT_URL"`
	PublishableKey           string `env:"auth.publishable_key,default=PUBLISHABLE_KEY"`
	SecretKey                string `env:"auth.secret_key,default=SECRET_KEY"`
	JWTSecret                string `env:"auth.jwt_secret,default=JWT_SECRET,deprecated"`
	AnonKey                  string `env:"auth.anon_key,default=ANON_KEY,deprecated"`
	ServiceRoleKey           string `env:"auth.service_role_key,default=SERVICE_ROLE_KEY,deprecated"`
	StorageS3AccessKeyId     string `env:"storage.s3_access_key_id,default=S3_PROTOCOL_ACCESS_KEY_ID"`
	StorageS3SecretAccessKey string `env:"storage.s3_secret_access_key,default=S3_PROTOCOL_ACCESS_KEY_SECRET"`
	StorageS3Region          string `env:"storage.s3_region,default=S3_PROTOCOL_REGION"`
}

func (c *CustomName) toValues(exclude ...string) map[string]string {
	values := map[string]string{
		c.DbURL: fmt.Sprintf("postgresql://%s@%s:%d/postgres", url.UserPassword("postgres", utils.Config.Db.Password), utils.Config.Hostname, utils.Config.Db.Port),
	}

	apiEnabled := utils.Config.Api.Enabled && !slices.Contains(exclude, utils.RestId) && !slices.Contains(exclude, utils.ShortContainerImageName(utils.Config.Api.Image))
	studioEnabled := utils.Config.Studio.Enabled && !slices.Contains(exclude, utils.StudioId) && !slices.Contains(exclude, utils.ShortContainerImageName(utils.Config.Studio.Image))
	authEnabled := utils.Config.Auth.Enabled && !slices.Contains(exclude, utils.GotrueId) && !slices.Contains(exclude, utils.ShortContainerImageName(utils.Config.Auth.Image))
	inbucketEnabled := utils.Config.Inbucket.Enabled && !slices.Contains(exclude, utils.InbucketId) && !slices.Contains(exclude, utils.ShortContainerImageName(utils.Config.Inbucket.Image))
	storageEnabled := utils.Config.Storage.Enabled && !slices.Contains(exclude, utils.StorageId) && !slices.Contains(exclude, utils.ShortContainerImageName(utils.Config.Storage.Image))
	functionsEnabled := utils.Config.EdgeRuntime.Enabled && !slices.Contains(exclude, utils.EdgeRuntimeId) && !slices.Contains(exclude, utils.ShortContainerImageName(utils.Config.EdgeRuntime.Image))

	if apiEnabled {
		values[c.ApiURL] = utils.Config.Api.ExternalUrl
		values[c.RestURL] = utils.GetApiUrl("/rest/v1")
		values[c.GraphqlURL] = utils.GetApiUrl("/graphql/v1")
		if functionsEnabled {
			values[c.FunctionsURL] = utils.GetApiUrl("/functions/v1")
		}
		if studioEnabled {
			values[c.McpURL] = utils.GetApiUrl("/mcp")
		}
	}
	if studioEnabled {
		values[c.StudioURL] = fmt.Sprintf("http://%s:%d", utils.Config.Hostname, utils.Config.Studio.Port)
	}
	if authEnabled {
		values[c.PublishableKey] = utils.Config.Auth.PublishableKey.Value
		values[c.SecretKey] = utils.Config.Auth.SecretKey.Value
		values[c.JWTSecret] = utils.Config.Auth.JwtSecret.Value
		values[c.AnonKey] = utils.Config.Auth.AnonKey.Value
		values[c.ServiceRoleKey] = utils.Config.Auth.ServiceRoleKey.Value
	}
	if inbucketEnabled {
		values[c.MailpitURL] = fmt.Sprintf("http://%s:%d", utils.Config.Hostname, utils.Config.Inbucket.Port)
		values[c.InbucketURL] = fmt.Sprintf("http://%s:%d", utils.Config.Hostname, utils.Config.Inbucket.Port)
	}
	if storageEnabled && utils.Config.Storage.S3Protocol != nil && utils.Config.Storage.S3Protocol.Enabled {
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
		if pool.AppendCertsFromPEM(utils.Config.Api.Tls.CertContent) {
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
		healthClient = fetcher.NewServiceGateway(
			utils.Config.Api.ExternalUrl,
			utils.Config.Auth.SecretKey.Value,
			fetcher.WithHTTPClient(NewKongClient()),
			fetcher.WithUserAgent("SupabaseCLI/"+utils.Version),
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
	logger := utils.GetDebugLogger()

	names := CustomName{}
	if err := env.Unmarshal(env.EnvSet{}, &names); err != nil {
		fmt.Fprintln(logger, err)
	}
	values := names.toValues(exclude...)

	groups := []OutputGroup{
		{
			Name: "🔧 Development Tools",
			Items: []OutputItem{
				{Label: "Studio", Value: values[names.StudioURL], Type: Link},
				{Label: "Mailpit", Value: values[names.MailpitURL], Type: Link},
				{Label: "MCP", Value: values[names.McpURL], Type: Link},
			},
		},
		{
			Name: "🌐 APIs",
			Items: []OutputItem{
				{Label: "Project URL", Value: values[names.ApiURL], Type: Link},
				{Label: "REST", Value: values[names.RestURL], Type: Link},
				{Label: "GraphQL", Value: values[names.GraphqlURL], Type: Link},
				{Label: "Edge Functions", Value: values[names.FunctionsURL], Type: Link},
			},
		},
		{
			Name: "⛁ Database",
			Items: []OutputItem{
				{Label: "URL", Value: values[names.DbURL], Type: Link},
			},
		},
		{
			Name: "🔑 Authentication Keys",
			Items: []OutputItem{
				{Label: "Publishable", Value: values[names.PublishableKey], Type: Key},
				{Label: "Secret", Value: values[names.SecretKey], Type: Key},
			},
		},
		{
			Name: "📦 Storage (S3)",
			Items: []OutputItem{
				{Label: "URL", Value: values[names.StorageS3URL], Type: Link},
				{Label: "Access Key", Value: values[names.StorageS3AccessKeyId], Type: Key},
				{Label: "Secret Key", Value: values[names.StorageS3SecretAccessKey], Type: Key},
				{Label: "Region", Value: values[names.StorageS3Region], Type: Text},
			},
		},
	}

	for _, group := range groups {
		if err := group.printTable(w); err != nil {
			fmt.Fprintln(logger, err)
		} else {
			fmt.Fprintln(w)
		}
	}
}

type OutputType string

const (
	Text OutputType = "text"
	Link OutputType = "link"
	Key  OutputType = "key"
)

type OutputItem struct {
	Label string
	Value string
	Type  OutputType
}

type OutputGroup struct {
	Name  string
	Items []OutputItem
}

func (g *OutputGroup) printTable(w io.Writer) error {
	table := tablewriter.NewTable(w,
		// Rounded corners
		tablewriter.WithSymbols(tw.NewSymbols(tw.StyleRounded)),

		// Table content formatting
		tablewriter.WithConfig(tablewriter.Config{
			Header: tw.CellConfig{
				Formatting: tw.CellFormatting{
					AutoFormat: tw.Off,
					MergeMode:  tw.MergeHorizontal,
				},
				Alignment: tw.CellAlignment{
					Global: tw.AlignLeft,
				},
				Filter: tw.CellFilter{
					Global: func(s []string) []string {
						for i := range s {
							s[i] = utils.Bold(s[i])
						}
						return s
					},
				},
			},
			Row: tw.CellConfig{
				Alignment: tw.CellAlignment{
					Global: tw.AlignLeft,
				},
				ColMaxWidths: tw.CellWidth{
					PerColumn: map[int]int{0: 16},
				},
				Filter: tw.CellFilter{
					PerColumn: []func(string) string{
						func(s string) string {
							return utils.Green(s)
						},
					},
				},
			},
			Behavior: tw.Behavior{
				Compact: tw.Compact{
					Merge: tw.On,
				},
			},
		}),

		// Set title as header (merged across all columns)
		tablewriter.WithHeader([]string{g.Name, g.Name}),
	)

	// Add data rows with values colored based on type
	shouldRender := false
	for _, row := range g.Items {
		if row.Value == "" {
			continue
		}
		value := row.Value
		switch row.Type {
		case Link:
			value = utils.Aqua(row.Value)
		case Key:
			value = utils.Yellow(row.Value)
		}
		if err := table.Append(row.Label, value); err != nil {
			return errors.Errorf("failed to append row: %w", err)
		}
		shouldRender = true
	}

	// Ensure at least one item in the group is non-empty
	if shouldRender {
		if err := table.Render(); err != nil {
			return errors.Errorf("failed to render table: %w", err)
		}
	}

	return nil
}
