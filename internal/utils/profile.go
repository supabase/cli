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
	PoolerHost   string `mapstructure:"pooler_host" validate:"omitempty,hostname_rfc1123"`
	DocsURL      string `mapstructure:"docs_url" validate:"omitempty,http_url"`
	StudioImage  string `mapstructure:"studio_image"`
}

var allProfiles = []Profile{{
	Name:         "supabase",
	APIURL:       "https://api.supabase.com",
	DashboardURL: "https://supabase.com/dashboard",
	DocsURL:      "https://supabase.com/docs",
	ProjectHost:  "supabase.co",
	PoolerHost:   "supabase.com",
}, {
	Name:         "supabase-staging",
	APIURL:       "https://api.supabase.green",
	DashboardURL: "https://supabase.green/dashboard",
	DocsURL:      "https://supabase.com/docs",
	ProjectHost:  "supabase.red",
	PoolerHost:   "supabase.green",
}, {
	Name:         "supabase-local",
	APIURL:       "http://localhost:8080",
	DashboardURL: "http://localhost:8082",
	DocsURL:      "https://supabase.com/docs",
	ProjectHost:  "supabase.red",
}, {
	Name:         "snap",
	APIURL:       "https://cloudapi.snap.com",
	DashboardURL: "https://cloud.snap.com/dashboard",
	DocsURL:      "https://cloud.snap.com/docs",
	ProjectHost:  "snapcloud.dev",
	PoolerHost:   "snapcloud.co",
}}

var CurrentProfile Profile

func LoadProfile(ctx context.Context, fsys afero.Fs) error {
	prof := getProfileName(fsys)
	for _, p := range allProfiles {
		if strings.EqualFold(p.Name, prof) {
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

func getProfileName(fsys afero.Fs) string {
	debuglogger := GetDebugLogger()
	if prof := viper.GetString("PROFILE"); viper.IsSet("PROFILE") {
		fmt.Fprintln(debuglogger, "Loading profile from flag:", prof)
		return prof
	} else if content, err := afero.ReadFile(fsys, ProfilePath); err == nil {
		fmt.Fprintln(debuglogger, "Loading profile from file:", ProfilePath)
		return string(content)
	} else {
		fmt.Fprintln(debuglogger, err)
		return prof
	}
}
