package start

import (
	"bytes"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"text/template"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/docker/go-connections/nat"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/status"
	"github.com/supabase/cli/internal/utils"
)

var errUnhealthy = errors.New("service not healthy")

func Run(ctx context.Context, fsys afero.Fs, excludedContainers []string, ignoreHealthCheck bool) error {
	// Sanity checks.
	{
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}
		if err := utils.AssertDockerIsRunning(ctx); err != nil {
			return err
		}
		if _, err := utils.Docker.ContainerInspect(ctx, utils.DbId); err == nil {
			fmt.Fprintln(os.Stderr, utils.Aqua("supabase start")+" is already running.")
			fmt.Fprintln(os.Stderr, "Run "+utils.Aqua("supabase status")+" to show status of local Supabase containers.")
			return nil
		}
	}

	if err := utils.RunProgram(ctx, func(p utils.Program, ctx context.Context) error {
		return run(p, ctx, fsys, excludedContainers)
	}); err != nil {
		if ignoreHealthCheck && errors.Is(err, errUnhealthy) {
			fmt.Fprintln(os.Stderr, err)
		} else {
			utils.DockerRemoveAll(context.Background())
			return err
		}
	}

	fmt.Fprintf(os.Stderr, "Started %s local development setup.\n\n", utils.Aqua("supabase"))
	status.PrettyPrint(os.Stdout, excludedContainers...)
	return nil
}

type kongConfig struct {
	ProjectId string
	ApiKeys   map[string]string
}

var (
	//go:embed templates/kong_config
	kongConfigEmbed    string
	kongConfigTemplate = template.Must(template.New("kongConfig").Parse(kongConfigEmbed))
	customRoleKey      = regexp.MustCompile(`^SUPABASE_AUTH_(.*)_KEY$`)
)

func NewKongConfig() kongConfig {
	config := kongConfig{
		ProjectId: utils.Config.ProjectId,
		ApiKeys: map[string]string{
			"anon":         utils.Config.Auth.AnonKey,
			"service_role": utils.Config.Auth.ServiceRoleKey,
		},
	}
	for _, kv := range os.Environ() {
		apikey := strings.Split(kv, "=")
		match := customRoleKey.FindStringSubmatch(apikey[0])
		if len(match) == 2 {
			role := strings.ToLower(match[1])
			config.ApiKeys[role] = apikey[1]
		}
	}
	return config
}

type vectorConfig struct {
	ApiKey     string
	LogflareId string
	KongId     string
	GotrueId   string
	RestId     string
	RealtimeId string
	StorageId  string
	DbId       string
}

var (
	//go:embed templates/vector.yaml
	vectorConfigEmbed    string
	vectorConfigTemplate = template.Must(template.New("vectorConfig").Parse(vectorConfigEmbed))
)

func run(p utils.Program, ctx context.Context, fsys afero.Fs, excludedContainers []string, options ...func(*pgx.ConnConfig)) error {
	excluded := make(map[string]bool)
	for _, name := range excludedContainers {
		excluded[name] = true
	}

	// Pull images.
	{
		total := len(utils.ServiceImages) + 1
		p.Send(utils.StatusMsg(fmt.Sprintf("Pulling images... (1/%d)", total)))
		if err := utils.DockerPullImageIfNotCached(ctx, utils.DbImage); err != nil {
			return err
		}
		for i, image := range utils.ServiceImages {
			if isContainerExcluded(image, excluded) {
				fmt.Fprintln(os.Stderr, "Excluding container:", image)
				continue
			}
			p.Send(utils.StatusMsg(fmt.Sprintf("Pulling images... (%d/%d)", i+1, total)))
			if err := utils.DockerPullImageIfNotCached(ctx, image); err != nil {
				return err
			}
		}
	}

	// Start vector
	if utils.Config.Analytics.Enabled && !isContainerExcluded(utils.VectorImage, excluded) {
		var vectorConfigBuf bytes.Buffer
		if err := vectorConfigTemplate.Execute(&vectorConfigBuf, vectorConfig{
			ApiKey:     utils.Config.Analytics.ApiKey,
			LogflareId: utils.LogflareId,
			KongId:     utils.KongId,
			GotrueId:   utils.GotrueId,
			RestId:     utils.RestId,
			RealtimeId: utils.RealtimeId,
			StorageId:  utils.StorageId,
			DbId:       utils.DbId,
		}); err != nil {
			return err
		}
		p.Send(utils.StatusMsg("Starting syslog driver..."))
		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Image: utils.VectorImage,
				Env: []string{
					"VECTOR_CONFIG=/etc/vector/vector.yaml",
				},
				Entrypoint: []string{"sh", "-c", `cat <<'EOF' > /etc/vector/vector.yaml && vector
` + vectorConfigBuf.String() + `
EOF
`},
				Healthcheck: &container.HealthConfig{
					Test:     []string{"CMD", "bash", "-c", "printf \\0 > /dev/tcp/localhost/9000"},
					Interval: 2 * time.Second,
					Timeout:  2 * time.Second,
					Retries:  10,
				},
				ExposedPorts: nat.PortSet{"9000/tcp": {}},
			},
			container.HostConfig{
				PortBindings:  nat.PortMap{"9000/tcp": []nat.PortBinding{{HostPort: strconv.FormatUint(uint64(utils.Config.Analytics.VectorPort), 10)}}},
				RestartPolicy: container.RestartPolicy{Name: "always"},
			},
			utils.VectorId,
		); err != nil {
			return err
		}
		if err := waitForServiceReady(ctx, []string{utils.VectorId}); err != nil {
			return err
		}
	}

	// Start Postgres.
	w := utils.StatusWriter{Program: p}
	if err := start.StartDatabase(ctx, fsys, w, options...); err != nil {
		return err
	}

	p.Send(utils.StatusMsg("Starting containers..."))
	var started []string

	// Start Logflare
	if utils.Config.Analytics.Enabled && !isContainerExcluded(utils.LogflareImage, excluded) {
		workdir, _ := utils.GetProjectRoot(fsys)

		hostJwtPath := filepath.Join(workdir, utils.Config.Analytics.GcpJwtPath)
		jwtPath := hostJwtPath + ":/opt/app/rel/logflare/bin/gcloud.json"
		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Hostname: "127.0.0.1",
				Image:    utils.LogflareImage,
				Env: []string{
					"DB_DATABASE=postgres",
					"DB_HOSTNAME=" + utils.DbId,
					"DB_PORT=5432",
					"DB_SCHEMA=_analytics",
					"DB_USERNAME=supabase_admin",
					"DB_PASSWORD=postgres",
					"LOGFLARE_SINGLE_TENANT=true",
					"LOGFLARE_SUPABASE_MODE=true",
					"LOGFLARE_API_KEY=" + utils.Config.Analytics.ApiKey,
					"LOGFLARE_LOG_LEVEL=warn",
					"GOOGLE_DATASET_ID_APPEND=_default",
					"GOOGLE_PROJECT_ID=" + utils.Config.Analytics.GcpProjectId,
					"GOOGLE_PROJECT_NUMBER=" + utils.Config.Analytics.GcpProjectNumber,
				},
				Healthcheck: &container.HealthConfig{
					Test:     []string{"CMD", "curl", "-sSfL", "--head", "-o", "/dev/null", "http://localhost:4000/health"},
					Interval: 2 * time.Second,
					Timeout:  2 * time.Second,
					Retries:  10,
				},
				ExposedPorts: nat.PortSet{"4000/tcp": {}},
			},
			container.HostConfig{
				Binds:         []string{jwtPath},
				PortBindings:  nat.PortMap{"4000/tcp": []nat.PortBinding{{HostPort: strconv.FormatUint(uint64(utils.Config.Analytics.Port), 10)}}},
				RestartPolicy: container.RestartPolicy{Name: "always"},
			},
			utils.LogflareId,
		); err != nil {
			return err
		}
		started = append(started, utils.LogflareId)
	}

	// Start Kong.
	if !isContainerExcluded(utils.KongImage, excluded) {
		var kongConfigBuf bytes.Buffer
		if err := kongConfigTemplate.Execute(&kongConfigBuf, NewKongConfig()); err != nil {
			return err
		}

		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Image: utils.KongImage,
				Env: []string{
					"KONG_DATABASE=off",
					"KONG_DECLARATIVE_CONFIG=/home/kong/kong.yml",
					"KONG_DNS_ORDER=LAST,A,CNAME", // https://github.com/supabase/cli/issues/14
					"KONG_PLUGINS=request-transformer,cors,key-auth",
					// Need to increase the nginx buffers in kong to avoid it rejecting the rather
					// sizeable response headers azure can generate
					// Ref: https://github.com/Kong/kong/issues/3974#issuecomment-482105126
					"KONG_NGINX_PROXY_PROXY_BUFFER_SIZE=160k",
					"KONG_NGINX_PROXY_PROXY_BUFFERS=64 160k",
				},
				Entrypoint: []string{"sh", "-c", `cat <<'EOF' > /home/kong/kong.yml && ./docker-entrypoint.sh kong docker-start
` + kongConfigBuf.String() + `
EOF
`},
			},
			start.WithSyslogConfig(container.HostConfig{
				PortBindings:  nat.PortMap{"8000/tcp": []nat.PortBinding{{HostPort: strconv.FormatUint(uint64(utils.Config.Api.Port), 10)}}},
				RestartPolicy: container.RestartPolicy{Name: "always"},
			}),
			utils.KongId,
		); err != nil {
			return err
		}
		started = append(started, utils.KongId)
	}

	// Start GoTrue.
	if !isContainerExcluded(utils.GotrueImage, excluded) {
		env := []string{
			fmt.Sprintf("API_EXTERNAL_URL=http://localhost:%v", utils.Config.Api.Port),

			"GOTRUE_API_HOST=0.0.0.0",
			"GOTRUE_API_PORT=9999",

			"GOTRUE_DB_DRIVER=postgres",
			"GOTRUE_DB_DATABASE_URL=postgresql://supabase_auth_admin:postgres@" + utils.DbId + ":5432/postgres",

			"GOTRUE_SITE_URL=" + utils.Config.Auth.SiteUrl,
			"GOTRUE_URI_ALLOW_LIST=" + strings.Join(utils.Config.Auth.AdditionalRedirectUrls, ","),
			fmt.Sprintf("GOTRUE_DISABLE_SIGNUP=%v", !*utils.Config.Auth.EnableSignup),

			"GOTRUE_JWT_ADMIN_ROLES=service_role",
			"GOTRUE_JWT_AUD=authenticated",
			"GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated",
			fmt.Sprintf("GOTRUE_JWT_EXP=%v", utils.Config.Auth.JwtExpiry),
			"GOTRUE_JWT_SECRET=" + utils.Config.Auth.JwtSecret,

			fmt.Sprintf("GOTRUE_EXTERNAL_EMAIL_ENABLED=%v", *utils.Config.Auth.Email.EnableSignup),
			fmt.Sprintf("GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED=%v", *utils.Config.Auth.Email.DoubleConfirmChanges),
			fmt.Sprintf("GOTRUE_MAILER_AUTOCONFIRM=%v", !*utils.Config.Auth.Email.EnableConfirmations),

			"GOTRUE_SMTP_HOST=" + utils.InbucketId,
			"GOTRUE_SMTP_PORT=2500",
			"GOTRUE_SMTP_ADMIN_EMAIL=admin@email.com",
			"GOTRUE_SMTP_MAX_FREQUENCY=1s",
			"GOTRUE_MAILER_URLPATHS_INVITE=/auth/v1/verify",
			"GOTRUE_MAILER_URLPATHS_CONFIRMATION=/auth/v1/verify",
			"GOTRUE_MAILER_URLPATHS_RECOVERY=/auth/v1/verify",
			"GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE=/auth/v1/verify",
			"GOTRUE_RATE_LIMIT_EMAIL_SENT=360000",

			"GOTRUE_EXTERNAL_PHONE_ENABLED=true",
			"GOTRUE_SMS_AUTOCONFIRM=true",

			"GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED=false",
		}

		for name, config := range utils.Config.Auth.External {
			env = append(
				env,
				fmt.Sprintf("GOTRUE_EXTERNAL_%s_ENABLED=%v", strings.ToUpper(name), config.Enabled),
				fmt.Sprintf("GOTRUE_EXTERNAL_%s_CLIENT_ID=%s", strings.ToUpper(name), config.ClientId),
				fmt.Sprintf("GOTRUE_EXTERNAL_%s_SECRET=%s", strings.ToUpper(name), config.Secret),
			)

			if config.RedirectUri != "" {
				env = append(env,
					fmt.Sprintf("GOTRUE_EXTERNAL_%s_REDIRECT_URI=%s", strings.ToUpper(name), config.RedirectUri),
				)
			} else {
				env = append(env,
					fmt.Sprintf("GOTRUE_EXTERNAL_%s_REDIRECT_URI=http://localhost:%v/auth/v1/callback", strings.ToUpper(name), utils.Config.Api.Port),
				)
			}

			if config.Url != "" {
				env = append(env,
					fmt.Sprintf("GOTRUE_EXTERNAL_%s_URL=%s", strings.ToUpper(name), config.Url),
				)
			}
		}

		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Image: utils.GotrueImage,
				Env:   env,
				Healthcheck: &container.HealthConfig{
					Test:     []string{"CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:9999/health"},
					Interval: 2 * time.Second,
					Timeout:  2 * time.Second,
					Retries:  10,
				},
			},
			start.WithSyslogConfig(container.HostConfig{
				RestartPolicy: container.RestartPolicy{Name: "always"},
			}),
			utils.GotrueId,
		); err != nil {
			return err
		}
		started = append(started, utils.GotrueId)
	}

	// Start Inbucket.
	if !isContainerExcluded(utils.InbucketImage, excluded) {
		inbucketPortBindings := nat.PortMap{"9000/tcp": []nat.PortBinding{{HostPort: strconv.FormatUint(uint64(utils.Config.Inbucket.Port), 10)}}}
		if utils.Config.Inbucket.SmtpPort != 0 {
			inbucketPortBindings["2500/tcp"] = []nat.PortBinding{{HostPort: strconv.FormatUint(uint64(utils.Config.Inbucket.SmtpPort), 10)}}
		}
		if utils.Config.Inbucket.Pop3Port != 0 {
			inbucketPortBindings["1100/tcp"] = []nat.PortBinding{{HostPort: strconv.FormatUint(uint64(utils.Config.Inbucket.Pop3Port), 10)}}
		}
		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Image: utils.InbucketImage,
			},
			container.HostConfig{
				PortBindings:  inbucketPortBindings,
				RestartPolicy: container.RestartPolicy{Name: "always"},
			},
			utils.InbucketId,
		); err != nil {
			return err
		}
		started = append(started, utils.InbucketId)
	}

	// Start Realtime.
	if !isContainerExcluded(utils.RealtimeImage, excluded) {
		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Image: utils.RealtimeImage,
				Env: []string{
					"PORT=4000",
					"DB_HOST=" + utils.DbId,
					"DB_PORT=5432",
					"DB_USER=postgres",
					"DB_PASSWORD=postgres",
					"DB_NAME=postgres",
					"DB_AFTER_CONNECT_QUERY=SET search_path TO _realtime",
					"DB_ENC_KEY=supabaserealtime",
					"API_JWT_SECRET=" + utils.Config.Auth.JwtSecret,
					"FLY_ALLOC_ID=abc123",
					"FLY_APP_NAME=realtime",
					"SECRET_KEY_BASE=EAx3IQ/wRG1v47ZD4NE4/9RzBI8Jmil3x0yhcW4V2NHBP6c2iPIzwjofi2Ep4HIG",
					"ERL_AFLAGS=-proto_dist inet_tcp",
					"ENABLE_TAILSCALE=false",
					"DNS_NODES=''",
					"RLIMIT_NOFILE=",
				},
				Cmd: []string{
					"/bin/sh", "-c",
					"/app/bin/migrate && /app/bin/realtime eval 'Realtime.Release.seeds(Realtime.Repo)' && /app/bin/server",
				},
				Healthcheck: &container.HealthConfig{
					Test:     []string{"CMD", "bash", "-c", "printf \\0 > /dev/tcp/localhost/4000"},
					Interval: 2 * time.Second,
					Timeout:  2 * time.Second,
					Retries:  10,
				},
			},
			start.WithSyslogConfig(container.HostConfig{
				RestartPolicy: container.RestartPolicy{Name: "always"},
			}),
			utils.RealtimeId,
		); err != nil {
			return err
		}
		started = append(started, utils.RealtimeId)
	}

	// Start PostgREST.
	if !isContainerExcluded(utils.PostgrestImage, excluded) {
		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Image: utils.PostgrestImage,
				Env: []string{
					"PGRST_DB_URI=postgresql://authenticator:postgres@" + utils.DbId + ":5432/postgres",
					"PGRST_DB_SCHEMAS=" + strings.Join(utils.Config.Api.Schemas, ","),
					"PGRST_DB_EXTRA_SEARCH_PATH=" + strings.Join(utils.Config.Api.ExtraSearchPath, ","),
					"PGRST_DB_ANON_ROLE=anon",
					"PGRST_JWT_SECRET=" + utils.Config.Auth.JwtSecret,
				},
				// PostgREST does not expose a shell for health check
			},
			start.WithSyslogConfig(container.HostConfig{
				RestartPolicy: container.RestartPolicy{Name: "always"},
			}),
			utils.RestId,
		); err != nil {
			return err
		}
		started = append(started, utils.RestId)
	}

	// Start Storage.
	if !isContainerExcluded(utils.StorageImage, excluded) {
		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Image: utils.StorageImage,
				Env: []string{
					"ANON_KEY=" + utils.Config.Auth.AnonKey,
					"SERVICE_KEY=" + utils.Config.Auth.ServiceRoleKey,
					"POSTGREST_URL=http://" + utils.RestId + ":3000",
					"PGRST_JWT_SECRET=" + utils.Config.Auth.JwtSecret,
					"DATABASE_URL=postgresql://supabase_storage_admin:postgres@" + utils.DbId + ":5432/postgres",
					fmt.Sprintf("FILE_SIZE_LIMIT=%v", utils.Config.Storage.FileSizeLimit),
					"STORAGE_BACKEND=file",
					"FILE_STORAGE_BACKEND_PATH=/var/lib/storage",
					"TENANT_ID=stub",
					// TODO: https://github.com/supabase/storage-api/issues/55
					"REGION=stub",
					"GLOBAL_S3_BUCKET=stub",
					"ENABLE_IMAGE_TRANSFORMATION=true",
					"IMGPROXY_URL=http://" + utils.ImgProxyId + ":5001",
				},
				Healthcheck: &container.HealthConfig{
					Test:     []string{"CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:5000/status"},
					Interval: 2 * time.Second,
					Timeout:  2 * time.Second,
					Retries:  10,
				},
			},
			start.WithSyslogConfig(container.HostConfig{
				RestartPolicy: container.RestartPolicy{Name: "always"},
				Binds:         []string{utils.StorageId + ":/var/lib/storage"},
			}),
			utils.StorageId,
		); err != nil {
			return err
		}
		started = append(started, utils.StorageId)
	}

	// Start Storage ImgProxy.
	if !isContainerExcluded(utils.ImageProxyImage, excluded) {
		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Image: utils.ImageProxyImage,
				Env: []string{
					"IMGPROXY_BIND=:5001",
					"IMGPROXY_LOCAL_FILESYSTEM_ROOT=/",
					"IMGPROXY_USE_ETAG=/",
				},
				Healthcheck: &container.HealthConfig{
					Test:     []string{"CMD", "imgproxy", "health"},
					Interval: 2 * time.Second,
					Timeout:  2 * time.Second,
					Retries:  10,
				},
			},
			container.HostConfig{
				VolumesFrom:   []string{utils.StorageId},
				RestartPolicy: container.RestartPolicy{Name: "always"},
			},
			utils.ImgProxyId,
		); err != nil {
			return err
		}
		started = append(started, utils.ImgProxyId)
	}

	// Start pg-meta.
	if !isContainerExcluded(utils.PgmetaImage, excluded) {
		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Image: utils.PgmetaImage,
				Env: []string{
					"PG_META_PORT=8080",
					"PG_META_DB_HOST=" + utils.DbId,
				},
				Healthcheck: &container.HealthConfig{
					Test:     []string{"CMD", "node", "-e", "require('http').get('http://localhost:8080/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"},
					Interval: 2 * time.Second,
					Timeout:  2 * time.Second,
					Retries:  10,
				},
			},
			container.HostConfig{
				RestartPolicy: container.RestartPolicy{Name: "always"},
			},
			utils.PgmetaId,
		); err != nil {
			return err
		}
		started = append(started, utils.PgmetaId)
	}

	// Start Studio.
	if !isContainerExcluded(utils.StudioImage, excluded) {
		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Image: utils.StudioImage,
				Env: []string{
					"STUDIO_PG_META_URL=http://" + utils.PgmetaId + ":8080",
					"POSTGRES_PASSWORD=postgres",
					"SUPABASE_URL=http://" + utils.KongId + ":8000",
					fmt.Sprintf("SUPABASE_REST_URL=http://localhost:%v/rest/v1/", utils.Config.Api.Port),
					fmt.Sprintf("SUPABASE_PUBLIC_URL=http://localhost:%v/", utils.Config.Api.Port),
					"SUPABASE_ANON_KEY=" + utils.Config.Auth.AnonKey,
					"SUPABASE_SERVICE_KEY=" + utils.Config.Auth.ServiceRoleKey,
					"LOGFLARE_API_KEY=" + utils.Config.Analytics.ApiKey,
					fmt.Sprintf("LOGFLARE_URL=http://%v:%v", utils.LogflareId, utils.Config.Analytics.Port),
					fmt.Sprintf("NEXT_PUBLIC_ENABLE_LOGS=%v", utils.Config.Analytics.Enabled),
				},
				Healthcheck: &container.HealthConfig{
					Test:     []string{"CMD", "node", "-e", "require('http').get('http://localhost:3000/api/profile', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"},
					Interval: 2 * time.Second,
					Timeout:  2 * time.Second,
					Retries:  10,
				},
			},
			container.HostConfig{
				PortBindings:  nat.PortMap{"3000/tcp": []nat.PortBinding{{HostPort: strconv.FormatUint(uint64(utils.Config.Studio.Port), 10)}}},
				RestartPolicy: container.RestartPolicy{Name: "always"},
			},
			utils.StudioId,
		); err != nil {
			return err
		}
		started = append(started, utils.StudioId)
	}

	return waitForServiceReady(ctx, started)
}

func isContainerExcluded(imageName string, excluded map[string]bool) bool {
	short := utils.ShortContainerImageName(imageName)
	if val, ok := excluded[short]; ok && val {
		return true
	}
	return false
}

func ExcludableContainers() []string {
	names := []string{}
	for _, image := range utils.ServiceImages {
		names = append(names, utils.ShortContainerImageName(image))
	}
	return names
}

func waitForServiceReady(ctx context.Context, started []string) error {
	probe := func() bool {
		var unhealthy []string
		for _, container := range started {
			if !status.IsServiceReady(ctx, container) {
				unhealthy = append(unhealthy, container)
			}
		}
		started = unhealthy
		return len(started) == 0
	}
	if !reset.RetryEverySecond(ctx, probe, 20*time.Second) {
		// Print container logs for easier debugging
		for _, container := range started {
			logs, err := utils.Docker.ContainerLogs(ctx, container, types.ContainerLogsOptions{
				ShowStdout: true,
				ShowStderr: true,
			})
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				continue
			}
			fmt.Fprintln(os.Stderr, container, "container logs:")
			if _, err := stdcopy.StdCopy(os.Stderr, os.Stderr, logs); err != nil {
				fmt.Fprintln(os.Stderr, err)
			}
			logs.Close()
		}
		return fmt.Errorf("%w: %v", errUnhealthy, started)
	}
	return nil
}
