package seed

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/go-connections/nat"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/dump"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/utils"
)

type UserResponse struct {
	Id    string `json:"id"`
	Email string `json:"email"`
}

var (
	numberOfTestUsersCreated int = 5
)

func Run(ctx context.Context, fsys afero.Fs) error {
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}

	fmt.Println("Generating seed data examples for test users...")
	shadow, err := diff.CreateShadowDatabase(ctx)
	if err != nil {
		return err
	}
	defer utils.DockerRemove(shadow)
	if !start.WaitForHealthyService(ctx, shadow, start.HealthTimeout) {
		return errors.New(start.ErrDatabase)
	}
	config := pgconn.Config{
		Host:     "supabase_db_shadow",
		Port:     5432,
		User:     "supabase_auth_admin",
		Password: utils.Config.Db.Password,
		Database: "postgres",
	}
	source := utils.ToPostgresURL(config)

	// minimal set of config to get a shadow gotrue container running
	env := []string{
		fmt.Sprintf("API_EXTERNAL_URL=http://%s:%d", utils.Config.Hostname, utils.Config.Api.Port),

		"GOTRUE_API_HOST=0.0.0.0",
		"GOTRUE_API_PORT=9999",
		"GOTRUE_TRACING_ENABLED=false",
		"GOTRUE_METRICS_ENABLED=false",

		"GOTRUE_DB_DRIVER=postgres",
		"GOTRUE_DB_NAMESPACE=postgres",
		fmt.Sprintf("GOTRUE_DB_DATABASE_URL=%s", source),

		"GOTRUE_SITE_URL=" + utils.Config.Auth.SiteUrl,

		"GOTRUE_JWT_ADMIN_ROLES=service_role",
		"GOTRUE_JWT_AUD=authenticated",
		"GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated",
		fmt.Sprintf("GOTRUE_JWT_EXP=%v", utils.Config.Auth.JwtExpiry),
		"GOTRUE_JWT_SECRET=" + utils.Config.Auth.JwtSecret,
		fmt.Sprintf("GOTRUE_JWT_ISSUER=http://%s:%d/auth/v1", utils.Config.Hostname, utils.Config.Api.Port),
	}

	gotrueContainerId, err := utils.DockerStart(
		ctx,
		container.Config{
			Image:        utils.Config.Auth.Image,
			Env:          env,
			ExposedPorts: nat.PortSet{"9999/tcp": {}},
			Healthcheck: &container.HealthConfig{
				Test:     []string{"CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:9999/health"},
				Interval: 10 * time.Second,
				Timeout:  2 * time.Second,
				Retries:  3,
			},
		},
		container.HostConfig{
			PortBindings:  nat.PortMap{"9999/tcp": []nat.PortBinding{{HostPort: "54325"}}},
			RestartPolicy: container.RestartPolicy{Name: "always"},
		},
		network.NetworkingConfig{
			EndpointsConfig: map[string]*network.EndpointSettings{
				utils.NetId: {
					Aliases: utils.GotrueAliases,
				},
			},
		},
		fmt.Sprintf("%s_%s", utils.GotrueId, "shadow"),
	)
	if err != nil {
		return err
	}
	defer utils.DockerRemove(gotrueContainerId)
	if err := reset.WaitForServiceReady(ctx, []string{gotrueContainerId}); err != nil {
		return err
	}

	// call admin endpoint to create some test users
	if err := createTestUsers(ctx, numberOfTestUsersCreated); err != nil {
		return err
	}

	// write dump out to supabase/seed.example.sql file
	outStream, err := fsys.OpenFile(utils.SeedExampleDataPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return errors.Errorf("failed to open seed example file: %w", err)
	}
	defer outStream.Close()

	// dump data from shadow db
	if err := dump.DumpData(ctx, pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     uint16(utils.Config.Db.ShadowPort),
		User:     "postgres",
		Password: utils.Config.Db.Password,
		Database: "postgres",
	}, []string{"auth"}, []string{
		// auth schema needs to be specified to exclude the audit_log_entries table
		"auth.audit_log_entries",
		"instances",
		"sessions",
		"schema_migrations",
		"refresh_tokens",
		"mfa_amr_claims",
		"mfa_challenges",
		"mfa_factors",
		"saml_providers",
		"sso_providers",
		"sso_domains",
		"saml_relay_state",
		"flow_state",
	}, false, false, outStream); err != nil {
		return err
	}

	// use awk to remove unnecessary sections from the dump
	awkCmd := exec.Command("awk", `
		/-- Data for Name: users; Type: TABLE DATA; Schema: auth;/ {flag=1; next}
		/-- Data for Name: identities; Type: TABLE DATA; Schema: auth;/ {flag=1; next}
		/-- Data for Name:/ {flag=0} flag {print}
	`)
	dump, err := afero.ReadFile(fsys, utils.SeedExampleDataPath)
	if err != nil {
		return err
	}
	awkCmd.Stdin = bytes.NewReader(dump)
	var out bytes.Buffer
	awkCmd.Stdout = &out
	if err := awkCmd.Run(); err != nil {
		return err
	}
	if err := afero.WriteFile(fsys, utils.SeedExampleDataPath, out.Bytes(), 0644); err != nil {
		return err
	}

	fmt.Printf("Seed data written to %s\n", utils.SeedExampleDataPath)
	return nil
}

func createTestUsers(ctx context.Context, n int) error {
	reqEditors := func(ctx context.Context, req *http.Request) error {
		req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", utils.Config.Auth.ServiceRoleKey))
		return nil
	}
	endpoint := "http://localhost:54325/admin/users"

	for i := 0; i < n; i++ {
		reqBody := map[string]interface{}{
			"email":    fmt.Sprintf("test%v@supabase.io", i),
			"password": "password123",
		}
		_, err := utils.JsonResponse[UserResponse](ctx, "POST", endpoint, reqBody, reqEditors)
		if err != nil {
			return err
		}
	}
	return nil
}
