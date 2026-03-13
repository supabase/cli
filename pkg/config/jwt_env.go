package config

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/go-errors/errors"
)

// LocalJWTConfig holds all pre-computed JWT values needed by local services.
type LocalJWTConfig struct {
	JwtSecret      string
	JWKS           string
	SigningKeysJSON string
	ValidMethods   string
	AnonKey        string
	ServiceRoleKey string
	PublishableKey string
	SecretKey      string
	JwtExpiry      uint
	JwtIssuer      string
}

// BuildLocalJWTConfig computes all JWT-related configuration from auth settings.
func (a *auth) BuildLocalJWTConfig(ctx context.Context) (*LocalJWTConfig, error) {
	jwks, err := a.ResolveJWKS(ctx)
	if err != nil {
		return nil, err
	}

	cfg := &LocalJWTConfig{
		JwtSecret:      a.JwtSecret.Value,
		JWKS:           jwks,
		AnonKey:        a.AnonKey.Value,
		ServiceRoleKey: a.ServiceRoleKey.Value,
		PublishableKey: a.PublishableKey.Value,
		SecretKey:      a.SecretKey.Value,
		JwtExpiry:      a.JwtExpiry,
		JwtIssuer:      a.JwtIssuer,
	}

	// Serialize signing keys for GoTrue
	if keys, err := json.Marshal(a.SigningKeys); err == nil {
		cfg.SigningKeysJSON = string(keys)
	}

	// Compute valid methods from actual keys present
	methods := map[string]bool{}
	if len(a.JwtSecret.Value) > 0 {
		methods["HS256"] = true
	}
	for _, key := range a.SigningKeys {
		if alg := string(key.Algorithm); alg != "" {
			methods[alg] = true
		}
	}
	methodList := make([]string, 0, len(methods))
	for m := range methods {
		methodList = append(methodList, m)
	}
	// Sort for deterministic output
	sortMethods(methodList)
	cfg.ValidMethods = strings.Join(methodList, ",")

	return cfg, nil
}

// sortMethods sorts method names in a canonical order: HS256, ES256, RS256, then alphabetical.
func sortMethods(methods []string) {
	order := map[string]int{"HS256": 0, "ES256": 1, "RS256": 2}
	for i := range len(methods) {
		for j := i + 1; j < len(methods); j++ {
			oi, oki := order[methods[i]]
			oj, okj := order[methods[j]]
			if !oki {
				oi = 100
			}
			if !okj {
				oj = 100
			}
			if oi > oj || (oi == oj && methods[i] > methods[j]) {
				methods[i], methods[j] = methods[j], methods[i]
			}
		}
	}
}

// GoTrueEnv returns JWT-related environment variables for the GoTrue service.
func (c *LocalJWTConfig) GoTrueEnv() []string {
	env := []string{
		"GOTRUE_JWT_ADMIN_ROLES=service_role",
		"GOTRUE_JWT_AUD=authenticated",
		"GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated",
		fmt.Sprintf("GOTRUE_JWT_EXP=%v", c.JwtExpiry),
		"GOTRUE_JWT_SECRET=" + c.JwtSecret,
		"GOTRUE_JWT_ISSUER=" + c.JwtIssuer,
	}
	if len(c.SigningKeysJSON) > 0 {
		env = append(env,
			"GOTRUE_JWT_KEYS="+c.SigningKeysJSON,
			"GOTRUE_JWT_VALIDMETHODS="+c.ValidMethods,
		)
	}
	return env
}

// PostgRESTEnv returns JWT-related environment variables for PostgREST.
func (c *LocalJWTConfig) PostgRESTEnv() []string {
	return []string{
		fmt.Sprintf("PGRST_JWT_SECRET=%s", c.JWKS),
	}
}

// RealtimeEnv returns JWT-related environment variables for the Realtime service.
func (c *LocalJWTConfig) RealtimeEnv() []string {
	return []string{
		"API_JWT_SECRET=" + c.JwtSecret,
		fmt.Sprintf("API_JWT_JWKS=%s", c.JWKS),
		"METRICS_JWT_SECRET=" + c.JwtSecret,
	}
}

// StorageEnv returns JWT-related environment variables for the Storage service.
func (c *LocalJWTConfig) StorageEnv() []string {
	return []string{
		"ANON_KEY=" + c.AnonKey,
		"SERVICE_KEY=" + c.ServiceRoleKey,
		"AUTH_JWT_SECRET=" + c.JwtSecret,
		fmt.Sprintf("JWT_JWKS=%s", c.JWKS),
	}
}

// StudioEnv returns JWT-related environment variables for Studio.
func (c *LocalJWTConfig) StudioEnv() []string {
	return []string{
		"AUTH_JWT_SECRET=" + c.JwtSecret,
		"SUPABASE_ANON_KEY=" + c.AnonKey,
		"SUPABASE_SERVICE_KEY=" + c.ServiceRoleKey,
	}
}

// FunctionsEnv returns JWT-related environment variables for Edge Functions.
func (c *LocalJWTConfig) FunctionsEnv() []string {
	return []string{
		"SUPABASE_ANON_KEY=" + c.AnonKey,
		"SUPABASE_SERVICE_ROLE_KEY=" + c.ServiceRoleKey,
		"SUPABASE_INTERNAL_JWT_SECRET=" + c.JwtSecret,
		"SUPABASE_INTERNAL_JWT_JWKS=" + c.JWKS,
	}
}

// DatabaseEnv returns JWT-related environment variables for the database container.
func (c *LocalJWTConfig) DatabaseEnv() []string {
	return []string{
		"JWT_SECRET=" + c.JwtSecret,
		fmt.Sprintf("JWT_EXP=%d", c.JwtExpiry),
	}
}

// PoolerEnv returns JWT-related environment variables for the connection pooler.
func (c *LocalJWTConfig) PoolerEnv() []string {
	return []string{
		"API_JWT_SECRET=" + c.JwtSecret,
		"METRICS_JWT_SECRET=" + c.JwtSecret,
	}
}

// StorageInitEnv returns JWT-related environment variables for the Storage init job.
func (c *LocalJWTConfig) StorageInitEnv() []string {
	return []string{
		"ANON_KEY=" + c.AnonKey,
		"SERVICE_KEY=" + c.ServiceRoleKey,
		"PGRST_JWT_SECRET=" + c.JwtSecret,
	}
}

// AuthInitEnv returns JWT-related environment variables for the Auth init job.
func (c *LocalJWTConfig) AuthInitEnv() []string {
	return []string{
		"GOTRUE_JWT_SECRET=" + c.JwtSecret,
	}
}

// Validate checks that the LocalJWTConfig has minimum required values.
func (c *LocalJWTConfig) Validate() error {
	if len(c.JwtSecret) == 0 {
		return errors.New("jwt_secret is required")
	}
	return nil
}
