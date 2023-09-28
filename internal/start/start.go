package start

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"text/template"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/go-connections/nat"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/functions/serve"
	"github.com/supabase/cli/internal/gen/keys"
	"github.com/supabase/cli/internal/status"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, fsys afero.Fs, excludedContainers []string, ignoreHealthCheck bool, projectRef, dbUrl string) error {
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
		var dbConfig pgconn.Config
		if len(dbUrl) > 0 {
			config, err := pgconn.ParseConfig(dbUrl)
			if err != nil {
				return err
			}
			dbConfig = *config
		} else if len(projectRef) > 0 {
			branch := keys.GetGitBranch(fsys)
			if err := keys.GenerateSecrets(ctx, projectRef, branch, fsys); err != nil {
				return err
			}
			dbConfig = pgconn.Config{
				Host:     fmt.Sprintf("%s-%s.fly.dev", projectRef, branch),
				Port:     5432,
				User:     "postgres",
				Password: utils.Config.Db.Password,
				Database: "postgres",
			}
		} else {
			dbConfig = pgconn.Config{
				Host:     utils.DbId,
				Port:     5432,
				User:     "postgres",
				Password: utils.Config.Db.Password,
				Database: "postgres",
			}
		}
		return run(p, ctx, fsys, excludedContainers, dbConfig)
	}); err != nil {
		if ignoreHealthCheck && errors.Is(err, reset.ErrUnhealthy) {
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
	GotrueId      string
	RestId        string
	RealtimeId    string
	StorageId     string
	PgmetaId      string
	EdgeRuntimeId string
	LogflareId    string
	ApiPort       uint
}

var (
	//go:embed templates/kong.yml
	kongConfigEmbed    string
	kongConfigTemplate = template.Must(template.New("kongConfig").Parse(kongConfigEmbed))

	//go:embed templates/custom_nginx.template
	nginxConfigEmbed string
	// Hardcoded configs which match nginxConfigEmbed
	nginxEmailTemplateDir   = "/home/kong/templates/email"
	nginxTemplateServerPort = 8088
)

type vectorConfig struct {
	ApiKey        string
	LogflareId    string
	KongId        string
	GotrueId      string
	RestId        string
	RealtimeId    string
	StorageId     string
	EdgeRuntimeId string
	DbId          string
}

var (
	//go:embed templates/vector.yaml
	vectorConfigEmbed    string
	vectorConfigTemplate = template.Must(template.New("vectorConfig").Parse(vectorConfigEmbed))
)

func run(p utils.Program, ctx context.Context, fsys afero.Fs, excludedContainers []string, dbConfig pgconn.Config, options ...func(*pgx.ConnConfig)) error {
	excluded := make(map[string]bool)
	for _, name := range excludedContainers {
		excluded[name] = true
	}

	// Start vector
	if utils.Config.Analytics.Enabled && !isContainerExcluded(utils.VectorImage, excluded) {
		var vectorConfigBuf bytes.Buffer
		if err := vectorConfigTemplate.Execute(&vectorConfigBuf, vectorConfig{
			ApiKey:        utils.Config.Analytics.ApiKey,
			LogflareId:    utils.LogflareId,
			KongId:        utils.KongId,
			GotrueId:      utils.GotrueId,
			RestId:        utils.RestId,
			RealtimeId:    utils.RealtimeId,
			StorageId:     utils.StorageId,
			EdgeRuntimeId: utils.EdgeRuntimeId,
			DbId:          utils.DbId,
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
					Test: []string{"CMD",
						"wget",
						"--no-verbose",
						"--tries=1",
						"--spider",
						"http://localhost:9001/health"},
					Interval: 10 * time.Second,
					Timeout:  2 * time.Second,
					Retries:  3,
				},
				ExposedPorts: nat.PortSet{"9000/tcp": {}},
			},
			container.HostConfig{
				PortBindings:  nat.PortMap{"9000/tcp": []nat.PortBinding{{HostPort: strconv.FormatUint(uint64(utils.Config.Analytics.VectorPort), 10)}}},
				RestartPolicy: container.RestartPolicy{Name: "always"},
			},
			network.NetworkingConfig{
				EndpointsConfig: map[string]*network.EndpointSettings{
					utils.NetId: {
						Aliases: utils.VectorAliases,
					},
				},
			},
			utils.VectorId,
		); err != nil {
			return err
		}
		if err := reset.WaitForServiceReady(ctx, []string{utils.VectorId}); err != nil {
			return err
		}
	}

	// Start Postgres.
	w := utils.StatusWriter{Program: p}
	if dbConfig.Host == utils.DbId {
		if err := start.StartDatabase(ctx, fsys, w, options...); err != nil {
			return err
		}
	}

	var started []string
	// Start Logflare
	if utils.Config.Analytics.Enabled && !isContainerExcluded(utils.LogflareImage, excluded) {
		env := []string{
			"DB_DATABASE=" + dbConfig.Database,
			"DB_HOSTNAME=" + dbConfig.Host,
			fmt.Sprintf("DB_PORT=%d", dbConfig.Port),
			"DB_SCHEMA=_analytics",
			"DB_USERNAME=supabase_admin",
			"DB_PASSWORD=" + dbConfig.Password,
			"LOGFLARE_MIN_CLUSTER_SIZE=1",
			"LOGFLARE_SINGLE_TENANT=true",
			"LOGFLARE_SUPABASE_MODE=true",
			"LOGFLARE_API_KEY=" + utils.Config.Analytics.ApiKey,
			"LOGFLARE_LOG_LEVEL=warn",
			"LOGFLARE_NODE_HOST=127.0.0.1",
			"LOGFLARE_FEATURE_FLAG_OVERRIDE='multibackend=true'",
			"RELEASE_COOKIE=cookie",
		}
		bind := []string{}

		switch utils.Config.Analytics.Backend {
		case utils.LogflareBigQuery:
			workdir, err := os.Getwd()
			if err != nil {
				return err
			}
			hostJwtPath := filepath.Join(workdir, utils.Config.Analytics.GcpJwtPath)
			bind = append(bind, hostJwtPath+":/opt/app/rel/logflare/bin/gcloud.json")
			// This is hardcoded in studio frontend
			env = append(env,
				"GOOGLE_DATASET_ID_APPEND=_prod",
				"GOOGLE_PROJECT_ID="+utils.Config.Analytics.GcpProjectId,
				"GOOGLE_PROJECT_NUMBER="+utils.Config.Analytics.GcpProjectNumber,
			)
		case utils.LogflarePostgres:
			env = append(env,
				fmt.Sprintf("POSTGRES_BACKEND_URL=postgresql://%s:%s@%s:%d/%s", dbConfig.User, dbConfig.Password, dbConfig.Host, dbConfig.Port, dbConfig.Database),
				"POSTGRES_BACKEND_SCHEMA=_analytics",
			)
		}

		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Hostname: "127.0.0.1",
				Image:    utils.LogflareImage,
				Env:      env,
				// Original entrypoint conflicts with healthcheck due to 15 seconds sleep:
				// https://github.com/Logflare/logflare/blob/staging/run.sh#L35
				Entrypoint: []string{"sh", "-c", `cat <<'EOF' > run.sh && sh run.sh
./logflare eval Logflare.Release.migrate
./logflare start --sname logflare
EOF
`},
				Healthcheck: &container.HealthConfig{
					Test:        []string{"CMD", "curl", "-sSfL", "--head", "-o", "/dev/null", "http://localhost:4000/health"},
					Interval:    10 * time.Second,
					Timeout:     2 * time.Second,
					Retries:     3,
					StartPeriod: 10 * time.Second,
				},
				ExposedPorts: nat.PortSet{"4000/tcp": {}},
			},
			container.HostConfig{
				Binds:         bind,
				PortBindings:  nat.PortMap{"4000/tcp": []nat.PortBinding{{HostPort: strconv.FormatUint(uint64(utils.Config.Analytics.Port), 10)}}},
				RestartPolicy: container.RestartPolicy{Name: "always"},
			},
			network.NetworkingConfig{
				EndpointsConfig: map[string]*network.EndpointSettings{
					utils.NetId: {
						Aliases: utils.LogflareAliases,
					},
				},
			},
			utils.LogflareId,
		); err != nil {
			return err
		}
		if err := reset.WaitForServiceReady(ctx, []string{utils.LogflareId}); err != nil {
			return err
		}
	}

	// Start Kong.
	p.Send(utils.StatusMsg("Starting containers..."))
	if !isContainerExcluded(utils.KongImage, excluded) {
		var kongConfigBuf bytes.Buffer
		if err := kongConfigTemplate.Execute(&kongConfigBuf, kongConfig{
			GotrueId:      utils.GotrueId,
			RestId:        utils.RestId,
			RealtimeId:    utils.RealtimeId,
			StorageId:     utils.StorageId,
			PgmetaId:      utils.PgmetaId,
			EdgeRuntimeId: utils.EdgeRuntimeId,
			LogflareId:    utils.LogflareId,
			ApiPort:       utils.Config.Api.Port,
		}); err != nil {
			return err
		}

		binds := []string{}
		for id, tmpl := range utils.Config.Auth.Email.Template {
			if len(tmpl.ContentPath) == 0 {
				continue
			}
			hostPath := tmpl.ContentPath
			if !filepath.IsAbs(tmpl.ContentPath) {
				var err error
				hostPath, err = filepath.Abs(hostPath)
				if err != nil {
					return err
				}
			}
			dockerPath := path.Join(nginxEmailTemplateDir, id+filepath.Ext(hostPath))
			binds = append(binds, fmt.Sprintf("%s:%s:rw,z", hostPath, dockerPath))
		}

		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Image: utils.KongImage,
				Env: []string{
					"KONG_DATABASE=off",
					"KONG_DECLARATIVE_CONFIG=/home/kong/kong.yml",
					"KONG_DNS_ORDER=LAST,A,CNAME", // https://github.com/supabase/cli/issues/14
					"KONG_PLUGINS=request-transformer,cors",
					// Need to increase the nginx buffers in kong to avoid it rejecting the rather
					// sizeable response headers azure can generate
					// Ref: https://github.com/Kong/kong/issues/3974#issuecomment-482105126
					"KONG_NGINX_PROXY_PROXY_BUFFER_SIZE=160k",
					"KONG_NGINX_PROXY_PROXY_BUFFERS=64 160k",
					"KONG_NGINX_WORKER_PROCESSES=1",
				},
				Entrypoint: []string{"sh", "-c", `cat <<'EOF' > /home/kong/kong.yml && cat <<'EOF' > /home/kong/custom_nginx.template && ./docker-entrypoint.sh kong docker-start --nginx-conf /home/kong/custom_nginx.template
` + kongConfigBuf.String() + `
EOF
` + nginxConfigEmbed + `
EOF
`},
			},
			start.WithSyslogConfig(container.HostConfig{
				Binds:         binds,
				PortBindings:  nat.PortMap{"8000/tcp": []nat.PortBinding{{HostPort: strconv.FormatUint(uint64(utils.Config.Api.Port), 10)}}},
				RestartPolicy: container.RestartPolicy{Name: "always"},
			}),
			network.NetworkingConfig{
				EndpointsConfig: map[string]*network.EndpointSettings{
					utils.NetId: {
						Aliases: utils.KongAliases,
					},
				},
			},
			utils.KongId,
		); err != nil {
			return err
		}
		started = append(started, utils.KongId)
	}

	// Start GoTrue.
	if utils.Config.Auth.Enabled && !isContainerExcluded(utils.GotrueImage, excluded) {
		var testOTP bytes.Buffer
		if len(utils.Config.Auth.Sms.TestOTP) > 0 {
			encoder := json.NewEncoder(&testOTP)
			if err := encoder.Encode(utils.Config.Auth.Sms.TestOTP); err != nil {
				return err
			}
		}
		env := []string{
			fmt.Sprintf("API_EXTERNAL_URL=http://localhost:%v", utils.Config.Api.Port),

			"GOTRUE_API_HOST=0.0.0.0",
			"GOTRUE_API_PORT=9999",

			"GOTRUE_DB_DRIVER=postgres",
			fmt.Sprintf("GOTRUE_DB_DATABASE_URL=postgresql://supabase_auth_admin:%s@%s:%d/%s", dbConfig.Password, dbConfig.Host, dbConfig.Port, dbConfig.Database),

			"GOTRUE_SITE_URL=" + utils.Config.Auth.SiteUrl,
			"GOTRUE_URI_ALLOW_LIST=" + strings.Join(utils.Config.Auth.AdditionalRedirectUrls, ","),
			fmt.Sprintf("GOTRUE_DISABLE_SIGNUP=%v", !utils.Config.Auth.EnableSignup),

			"GOTRUE_JWT_ADMIN_ROLES=service_role",
			"GOTRUE_JWT_AUD=authenticated",
			"GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated",
			fmt.Sprintf("GOTRUE_JWT_EXP=%v", utils.Config.Auth.JwtExpiry),
			"GOTRUE_JWT_SECRET=" + utils.Config.Auth.JwtSecret,

			fmt.Sprintf("GOTRUE_EXTERNAL_EMAIL_ENABLED=%v", utils.Config.Auth.Email.EnableSignup),
			fmt.Sprintf("GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED=%v", utils.Config.Auth.Email.DoubleConfirmChanges),
			fmt.Sprintf("GOTRUE_MAILER_AUTOCONFIRM=%v", !utils.Config.Auth.Email.EnableConfirmations),

			"GOTRUE_SMTP_HOST=" + utils.InbucketId,
			"GOTRUE_SMTP_PORT=2500",
			"GOTRUE_SMTP_ADMIN_EMAIL=admin@email.com",
			"GOTRUE_SMTP_MAX_FREQUENCY=1s",
			// TODO: To be reverted to `/auth/v1/verify` once
			// https://github.com/supabase/supabase/issues/16100
			// is fixed on upstream GoTrue.
			fmt.Sprintf("GOTRUE_MAILER_URLPATHS_INVITE=http://localhost:%v/auth/v1/verify", utils.Config.Api.Port),
			fmt.Sprintf("GOTRUE_MAILER_URLPATHS_CONFIRMATION=http://localhost:%v/auth/v1/verify", utils.Config.Api.Port),
			fmt.Sprintf("GOTRUE_MAILER_URLPATHS_RECOVERY=http://localhost:%v/auth/v1/verify", utils.Config.Api.Port),
			fmt.Sprintf("GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE=http://localhost:%v/auth/v1/verify", utils.Config.Api.Port),
			"GOTRUE_RATE_LIMIT_EMAIL_SENT=360000",

			fmt.Sprintf("GOTRUE_EXTERNAL_PHONE_ENABLED=%v", utils.Config.Auth.Sms.EnableSignup),
			fmt.Sprintf("GOTRUE_SMS_AUTOCONFIRM=%v", !utils.Config.Auth.Sms.EnableConfirmations),
			"GOTRUE_SMS_MAX_FREQUENCY=5s",
			"GOTRUE_SMS_OTP_EXP=6000",
			"GOTRUE_SMS_OTP_LENGTH=6",
			"GOTRUE_SMS_TEMPLATE=Your code is {{ .Code }}",
			"GOTRUE_SMS_TEST_OTP=" + testOTP.String(),

			fmt.Sprintf("GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED=%v", utils.Config.Auth.EnableRefreshTokenRotation),
			fmt.Sprintf("GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL=%v", utils.Config.Auth.RefreshTokenReuseInterval),
		}

		for id, tmpl := range utils.Config.Auth.Email.Template {
			if len(tmpl.ContentPath) > 0 {
				env = append(env, fmt.Sprintf("GOTRUE_MAILER_TEMPLATES_%s=http://%s:%d/email/%s",
					strings.ToUpper(id),
					utils.KongId,
					nginxTemplateServerPort,
					id+filepath.Ext(tmpl.ContentPath),
				))
			}
			if len(tmpl.Subject) > 0 {
				env = append(env, fmt.Sprintf("GOTRUE_MAILER_SUBJECTS_%s=%s",
					strings.ToUpper(id),
					tmpl.Subject,
				))
			}
		}

		if utils.Config.Auth.Sms.Twilio.Enabled {
			env = append(
				env,
				"GOTRUE_SMS_PROVIDER=twilio",
				"GOTRUE_SMS_TWILIO_ACCOUNT_SID="+utils.Config.Auth.Sms.Twilio.AccountSid,
				"GOTRUE_SMS_TWILIO_AUTH_TOKEN="+utils.Config.Auth.Sms.Twilio.AuthToken,
				"GOTRUE_SMS_TWILIO_MESSAGE_SERVICE_SID="+utils.Config.Auth.Sms.Twilio.MessageServiceSid,
			)
		}
		if utils.Config.Auth.Sms.TwilioVerify.Enabled {
			env = append(
				env,
				"GOTRUE_SMS_PROVIDER=twilio_verify",
				"GOTRUE_SMS_TWILIO_VERIFY_ACCOUNT_SID="+utils.Config.Auth.Sms.TwilioVerify.AccountSid,
				"GOTRUE_SMS_TWILIO_VERIFY_AUTH_TOKEN="+utils.Config.Auth.Sms.TwilioVerify.AuthToken,
				"GOTRUE_SMS_TWILIO_VERIFY_MESSAGE_SERVICE_SID="+utils.Config.Auth.Sms.TwilioVerify.MessageServiceSid,
			)
		}
		if utils.Config.Auth.Sms.Messagebird.Enabled {
			env = append(
				env,
				"GOTRUE_SMS_PROVIDER=messagebird",
				"GOTRUE_SMS_MESSAGEBIRD_ACCESS_KEY="+utils.Config.Auth.Sms.Messagebird.AccessKey,
				"GOTRUE_SMS_MESSAGEBIRD_ORIGINATOR="+utils.Config.Auth.Sms.Messagebird.Originator,
			)
		}
		if utils.Config.Auth.Sms.Textlocal.Enabled {
			env = append(
				env,
				"GOTRUE_SMS_PROVIDER=textlocal",
				"GOTRUE_SMS_TEXTLOCAL_API_KEY="+utils.Config.Auth.Sms.Textlocal.ApiKey,
				"GOTRUE_SMS_TEXTLOCAL_SENDER="+utils.Config.Auth.Sms.Textlocal.Sender,
			)
		}
		if utils.Config.Auth.Sms.Vonage.Enabled {
			env = append(
				env,
				"GOTRUE_SMS_PROVIDER=vonage",
				"GOTRUE_SMS_VONAGE_API_KEY="+utils.Config.Auth.Sms.Vonage.ApiKey,
				"GOTRUE_SMS_VONAGE_API_SECRET="+utils.Config.Auth.Sms.Vonage.ApiSecret,
				"GOTRUE_SMS_VONAGE_FROM="+utils.Config.Auth.Sms.Vonage.From,
			)
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
				Image:        utils.Config.Auth.Image,
				Env:          env,
				ExposedPorts: nat.PortSet{"9999/tcp": {}},
				Healthcheck: &container.HealthConfig{
					Test:     []string{"CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:9999/health"},
					Interval: 10 * time.Second,
					Timeout:  2 * time.Second,
					Retries:  3,
				},
			},
			start.WithSyslogConfig(container.HostConfig{
				RestartPolicy: container.RestartPolicy{Name: "always"},
			}),
			network.NetworkingConfig{
				EndpointsConfig: map[string]*network.EndpointSettings{
					utils.NetId: {
						Aliases: utils.GotrueAliases,
					},
				},
			},
			utils.GotrueId,
		); err != nil {
			return err
		}
		started = append(started, utils.GotrueId)
	}

	// Start Inbucket.
	if utils.Config.Inbucket.Enabled && !isContainerExcluded(utils.InbucketImage, excluded) {
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
				Binds: []string{
					// Override default mount points to avoid creating multiple anonymous volumes
					// Ref: https://github.com/inbucket/inbucket/blob/v3.0.4/Dockerfile#L52
					utils.InbucketId + ":/config",
					utils.InbucketId + ":/storage",
				},
				PortBindings:  inbucketPortBindings,
				RestartPolicy: container.RestartPolicy{Name: "always"},
			},
			network.NetworkingConfig{
				EndpointsConfig: map[string]*network.EndpointSettings{
					utils.NetId: {
						Aliases: utils.InbucketAliases,
					},
				},
			},
			utils.InbucketId,
		); err != nil {
			return err
		}
		started = append(started, utils.InbucketId)
	}

	// Start Realtime.
	if utils.Config.Realtime.Enabled && !isContainerExcluded(utils.RealtimeImage, excluded) {
		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Image: utils.RealtimeImage,
				Env: []string{
					"PORT=4000",
					"DB_HOST=" + dbConfig.Host,
					fmt.Sprintf("DB_PORT=%d", dbConfig.Port),
					"DB_USER=supabase_admin",
					"DB_PASSWORD=" + dbConfig.Password,
					"DB_NAME=" + dbConfig.Database,
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
					"REALTIME_IP_VERSION=" + string(utils.Config.Realtime.IpVersion),
				},
				Cmd: []string{
					"/bin/sh", "-c",
					"/app/bin/migrate && /app/bin/realtime eval 'Realtime.Release.seeds(Realtime.Repo)' && /app/bin/server",
				},
				ExposedPorts: nat.PortSet{"4000/tcp": {}},
				Healthcheck: &container.HealthConfig{
					Test:     []string{"CMD", "bash", "-c", "printf \\0 > /dev/tcp/localhost/4000"},
					Interval: 10 * time.Second,
					Timeout:  2 * time.Second,
					Retries:  3,
				},
			},
			start.WithSyslogConfig(container.HostConfig{
				RestartPolicy: container.RestartPolicy{Name: "always"},
			}),
			network.NetworkingConfig{
				EndpointsConfig: map[string]*network.EndpointSettings{
					utils.NetId: {
						Aliases: utils.RealtimeAliases,
					},
				},
			},
			utils.RealtimeId,
		); err != nil {
			return err
		}
		started = append(started, utils.RealtimeId)
	}

	// Start PostgREST.
	if utils.Config.Api.Enabled && !isContainerExcluded(utils.Config.Api.Image, excluded) {
		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Image: utils.Config.Api.Image,
				Env: []string{
					fmt.Sprintf("PGRST_DB_URI=postgresql://authenticator:%s@%s:%d/%s", dbConfig.Password, dbConfig.Host, dbConfig.Port, dbConfig.Database),
					"PGRST_DB_SCHEMAS=" + strings.Join(utils.Config.Api.Schemas, ","),
					"PGRST_DB_EXTRA_SEARCH_PATH=" + strings.Join(utils.Config.Api.ExtraSearchPath, ","),
					fmt.Sprintf("PGRST_DB_MAX_ROWS=%d", utils.Config.Api.MaxRows),
					"PGRST_DB_ANON_ROLE=anon",
					"PGRST_JWT_SECRET=" + utils.Config.Auth.JwtSecret,
				},
				// PostgREST does not expose a shell for health check
			},
			start.WithSyslogConfig(container.HostConfig{
				RestartPolicy: container.RestartPolicy{Name: "always"},
			}),
			network.NetworkingConfig{
				EndpointsConfig: map[string]*network.EndpointSettings{
					utils.NetId: {
						Aliases: utils.RestAliases,
					},
				},
			},
			utils.RestId,
		); err != nil {
			return err
		}
		started = append(started, utils.RestId)
	}

	// Start Storage.
	if utils.Config.Storage.Enabled && !isContainerExcluded(utils.StorageImage, excluded) {
		dockerStoragePath := "/mnt"
		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Image: utils.StorageImage,
				Env: []string{
					"ANON_KEY=" + utils.Config.Auth.AnonKey,
					"SERVICE_KEY=" + utils.Config.Auth.ServiceRoleKey,
					"POSTGREST_URL=http://" + utils.RestId + ":3000",
					"PGRST_JWT_SECRET=" + utils.Config.Auth.JwtSecret,
					fmt.Sprintf("DATABASE_URL=postgresql://supabase_storage_admin:%s@%s:%d/%s", dbConfig.Password, dbConfig.Host, dbConfig.Port, dbConfig.Database),
					fmt.Sprintf("FILE_SIZE_LIMIT=%v", utils.Config.Storage.FileSizeLimit),
					"STORAGE_BACKEND=file",
					"FILE_STORAGE_BACKEND_PATH=" + dockerStoragePath,
					"TENANT_ID=stub",
					// TODO: https://github.com/supabase/storage-api/issues/55
					"REGION=stub",
					"GLOBAL_S3_BUCKET=stub",
					"ENABLE_IMAGE_TRANSFORMATION=true",
					"IMGPROXY_URL=http://" + utils.ImgProxyId + ":5001",
				},
				Healthcheck: &container.HealthConfig{
					// For some reason, localhost resolves to IPv6 address on GitPod which breaks healthcheck.
					Test:     []string{"CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:5000/status"},
					Interval: 10 * time.Second,
					Timeout:  2 * time.Second,
					Retries:  3,
				},
			},
			start.WithSyslogConfig(container.HostConfig{
				RestartPolicy: container.RestartPolicy{Name: "always"},
				Binds:         []string{utils.StorageId + ":" + dockerStoragePath},
			}),
			network.NetworkingConfig{
				EndpointsConfig: map[string]*network.EndpointSettings{
					utils.NetId: {
						Aliases: utils.StorageAliases,
					},
				},
			},
			utils.StorageId,
		); err != nil {
			return err
		}
		started = append(started, utils.StorageId)
	}

	// Start Storage ImgProxy.
	if utils.Config.Storage.Enabled && !isContainerExcluded(utils.ImageProxyImage, excluded) {
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
					Interval: 10 * time.Second,
					Timeout:  2 * time.Second,
					Retries:  3,
				},
			},
			container.HostConfig{
				VolumesFrom:   []string{utils.StorageId},
				RestartPolicy: container.RestartPolicy{Name: "always"},
			},
			network.NetworkingConfig{
				EndpointsConfig: map[string]*network.EndpointSettings{
					utils.NetId: {
						Aliases: utils.ImgProxyAliases,
					},
				},
			},
			utils.ImgProxyId,
		); err != nil {
			return err
		}
		started = append(started, utils.ImgProxyId)
	}

	// Start all functions.
	if !isContainerExcluded(utils.EdgeRuntimeImage, excluded) {
		dbUrl := fmt.Sprintf("postgresql://%s:%s@%s:%d/%s", dbConfig.User, dbConfig.Password, dbConfig.Host, dbConfig.Port, dbConfig.Database)
		if err := serve.ServeFunctions(ctx, "", nil, "", dbUrl, w, fsys); err != nil {
			return err
		}
		started = append(started, utils.EdgeRuntimeId)
	}

	// Start pg-meta.
	if utils.Config.Studio.Enabled && !isContainerExcluded(utils.PgmetaImage, excluded) {
		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Image: utils.PgmetaImage,
				Env: []string{
					"PG_META_PORT=8080",
					"PG_META_DB_HOST=" + dbConfig.Host,
					"PG_META_DB_NAME=" + dbConfig.Database,
					"PG_META_DB_USER=" + dbConfig.User,
					fmt.Sprintf("PG_META_DB_PORT=%d", dbConfig.Port),
					"PG_META_DB_PASSWORD=" + dbConfig.Password,
				},
				Healthcheck: &container.HealthConfig{
					Test:     []string{"CMD", "node", "-e", "require('http').get('http://localhost:8080/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"},
					Interval: 10 * time.Second,
					Timeout:  2 * time.Second,
					Retries:  3,
				},
			},
			container.HostConfig{
				RestartPolicy: container.RestartPolicy{Name: "always"},
			},
			network.NetworkingConfig{
				EndpointsConfig: map[string]*network.EndpointSettings{
					utils.NetId: {
						Aliases: utils.PgmetaAliases,
					},
				},
			},
			utils.PgmetaId,
		); err != nil {
			return err
		}
		started = append(started, utils.PgmetaId)
	}

	// Start Studio.
	if utils.Config.Studio.Enabled && !isContainerExcluded(utils.StudioImage, excluded) {
		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Image: utils.StudioImage,
				Env: []string{
					"STUDIO_PG_META_URL=http://" + utils.PgmetaId + ":8080",
					"POSTGRES_PASSWORD=" + dbConfig.Password,
					"SUPABASE_URL=http://" + utils.KongId + ":8000",
					fmt.Sprintf("SUPABASE_REST_URL=%s:%v/rest/v1/", utils.Config.Studio.ApiUrl, utils.Config.Api.Port),
					fmt.Sprintf("SUPABASE_PUBLIC_URL=%s:%v/", utils.Config.Studio.ApiUrl, utils.Config.Api.Port),
					"SUPABASE_ANON_KEY=" + utils.Config.Auth.AnonKey,
					"SUPABASE_SERVICE_KEY=" + utils.Config.Auth.ServiceRoleKey,
					"LOGFLARE_API_KEY=" + utils.Config.Analytics.ApiKey,
					fmt.Sprintf("LOGFLARE_URL=http://%v:4000", utils.LogflareId),
					fmt.Sprintf("NEXT_PUBLIC_ENABLE_LOGS=%v", utils.Config.Analytics.Enabled),
					fmt.Sprintf("NEXT_ANALYTICS_BACKEND_PROVIDER=%v", utils.Config.Analytics.Backend),
				},
				Healthcheck: &container.HealthConfig{
					Test:     []string{"CMD", "node", "-e", "require('http').get('http://localhost:3000/api/profile', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"},
					Interval: 10 * time.Second,
					Timeout:  2 * time.Second,
					Retries:  3,
				},
			},
			container.HostConfig{
				PortBindings:  nat.PortMap{"3000/tcp": []nat.PortBinding{{HostPort: strconv.FormatUint(uint64(utils.Config.Studio.Port), 10)}}},
				RestartPolicy: container.RestartPolicy{Name: "always"},
			},
			network.NetworkingConfig{
				EndpointsConfig: map[string]*network.EndpointSettings{
					utils.NetId: {
						Aliases: utils.StudioAliases,
					},
				},
			},
			utils.StudioId,
		); err != nil {
			return err
		}
		started = append(started, utils.StudioId)
	}

	// Start pooler.
	if utils.Config.Db.Pooler.Enabled && !isContainerExcluded(utils.PgbouncerImage, excluded) {
		if _, err := utils.DockerStart(
			ctx,
			container.Config{
				Image: utils.PgbouncerImage,
				Env: []string{
					"POSTGRESQL_HOST=" + dbConfig.Host,
					"POSTGRESQL_NAME=" + dbConfig.Database,
					"POSTGRESQL_USER=" + dbConfig.User,
					fmt.Sprintf("POSTGRESQL_PORT=%d", dbConfig.Port),
					"POSTGRESQL_PASSWORD=" + dbConfig.Password,
					fmt.Sprintf("PGBOUNCER_POOL_MODE=%s", utils.Config.Db.Pooler.PoolMode),
					fmt.Sprintf("PGBOUNCER_DEFAULT_POOL_SIZE=%d", utils.Config.Db.Pooler.DefaultPoolSize),
					fmt.Sprintf("PGBOUNCER_MAX_CLIENT_CONN=%d", utils.Config.Db.Pooler.MaxClientConn),
					// Default platform config: https://github.com/supabase/postgres/blob/develop/ansible/files/pgbouncer_config/pgbouncer.ini.j2
					"PGBOUNCER_IGNORE_STARTUP_PARAMETERS=extra_float_digits",
				},
				Healthcheck: &container.HealthConfig{
					Test:     []string{"CMD", "bash", "-c", "printf \\0 > /dev/tcp/localhost/6432"},
					Interval: 10 * time.Second,
					Timeout:  2 * time.Second,
					Retries:  3,
				},
			},
			container.HostConfig{
				PortBindings:  nat.PortMap{"6432/tcp": []nat.PortBinding{{HostPort: strconv.FormatUint(uint64(utils.Config.Db.Pooler.Port), 10)}}},
				RestartPolicy: container.RestartPolicy{Name: "always"},
			},
			network.NetworkingConfig{
				EndpointsConfig: map[string]*network.EndpointSettings{
					utils.NetId: {
						Aliases: utils.PoolerAliases,
					},
				},
			},
			utils.PoolerId,
		); err != nil {
			return err
		}
		started = append(started, utils.PoolerId)
	}

	p.Send(utils.StatusMsg("Waiting for health checks..."))
	return reset.WaitForServiceReady(ctx, started)
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
