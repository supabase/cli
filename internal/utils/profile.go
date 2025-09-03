package utils

import (
	"context"
	"fmt"
	"strings"

	"github.com/go-errors/errors"
	"github.com/go-playground/validator/v10"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
)

type Profile struct {
	Name         string `mapstructure:"name" validate:"required"`
	APIURL       string `mapstructure:"api_url" validate:"required,http_url"`
	DashboardURL string `mapstructure:"dashboard_url" validate:"required,http_url"`
	ProjectHost  string `mapstructure:"project_host" validate:"required,hostname_rfc1123"`
	DocsURL      string `mapstructure:"docs_url" validate:"omitempty,http_url"`
	StudioImage  string `mapstructure:"studio_image"`
}

var allProfiles = []Profile{{
	Name:         "supabase",
	APIURL:       "https://api.supabase.com",
	DashboardURL: "https://supabase.com/dashboard",
	DocsURL:      "https://supabase.com/docs",
	ProjectHost:  "supabase.co",
}, {
	Name:         "supabase-staging",
	APIURL:       "https://api.supabase.green",
	DashboardURL: "https://supabase.green/dashboard",
	DocsURL:      "https://supabase.com/docs",
	ProjectHost:  "supabase.red",
}, {
	Name:         "supabase-local",
	APIURL:       "http://localhost:8080",
	DashboardURL: "http://localhost:8082",
	DocsURL:      "https://supabase.com/docs",
	ProjectHost:  "supabase.red",
}}

var CurrentProfile Profile

func LoadProfile(ctx context.Context, fsys afero.Fs) error {
	prof := viper.GetString("PROFILE")
	for _, p := range allProfiles {
		if strings.EqualFold(p.Name, prof) {
			fmt.Fprintln(GetDebugLogger(), "Using project host:", p.ProjectHost)
			CurrentProfile = p
			return nil
		}
	}
	// Instantiate to avoid leaking profile into global viper state
	v := viper.New()
	v.SetFs(fsys)
	v.SetConfigFile(prof)
	if err := v.ReadInConfig(); err != nil {
		return errors.Errorf("failed to read profile: %w", err)
	}
	// Load profile into viper, rejecting keys not defined by config
	if err := v.UnmarshalExact(&CurrentProfile); err != nil {
		return errors.Errorf("failed to parse profile: %w", err)
	}
	validate := validator.New(validator.WithRequiredStructEnabled())
	if err := validate.StructCtx(ctx, &CurrentProfile); err != nil {
		return errors.Errorf("invalid profile: %w", err)
	}
	return nil
}
