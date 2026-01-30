package utils

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/go-errors/errors"
	"github.com/go-playground/validator/v10"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/pkg/api"
)

type Profile struct {
	Name           string                          `mapstructure:"name" validate:"required"`
	APIURL         string                          `mapstructure:"api_url" validate:"required,http_url"`
	DashboardURL   string                          `mapstructure:"dashboard_url" validate:"required,http_url"`
	DocsURL        string                          `mapstructure:"docs_url" validate:"omitempty,http_url"`
	ProjectHost    string                          `mapstructure:"project_host" validate:"required,hostname_rfc1123"`
	PoolerHost     string                          `mapstructure:"pooler_host" validate:"omitempty,hostname_rfc1123"`
	AuthClientID   string                          `mapstructure:"client_id" validate:"omitempty,uuid4"`
	StudioImage    string                          `mapstructure:"studio_image"`
	ProjectRegions []api.V1CreateProjectBodyRegion `mapstructure:"regions"`
}

var allProfiles = []Profile{{
	Name:         "supabase",
	APIURL:       "https://api.supabase.com",
	DashboardURL: "https://supabase.com/dashboard",
	DocsURL:      "https://supabase.com/docs",
	ProjectHost:  "supabase.co",
	PoolerHost:   "supabase.com",
	ProjectRegions: []api.V1CreateProjectBodyRegion{
		api.V1CreateProjectBodyRegionApEast1,
		api.V1CreateProjectBodyRegionApNortheast1,
		api.V1CreateProjectBodyRegionApNortheast2,
		api.V1CreateProjectBodyRegionApSouth1,
		api.V1CreateProjectBodyRegionApSoutheast1,
		api.V1CreateProjectBodyRegionApSoutheast2,
		api.V1CreateProjectBodyRegionCaCentral1,
		api.V1CreateProjectBodyRegionEuCentral1,
		api.V1CreateProjectBodyRegionEuCentral2,
		api.V1CreateProjectBodyRegionEuNorth1,
		api.V1CreateProjectBodyRegionEuWest1,
		api.V1CreateProjectBodyRegionEuWest2,
		api.V1CreateProjectBodyRegionEuWest3,
		api.V1CreateProjectBodyRegionSaEast1,
		api.V1CreateProjectBodyRegionUsEast1,
		api.V1CreateProjectBodyRegionUsEast2,
		api.V1CreateProjectBodyRegionUsWest1,
		api.V1CreateProjectBodyRegionUsWest2,
	},
}, {
	Name:         "supabase-staging",
	APIURL:       "https://api.supabase.green",
	DashboardURL: "https://supabase.green/dashboard",
	DocsURL:      "https://supabase.com/docs",
	ProjectHost:  "supabase.red",
	PoolerHost:   "supabase.green",
	ProjectRegions: []api.V1CreateProjectBodyRegion{
		api.V1CreateProjectBodyRegionApSoutheast1,
		api.V1CreateProjectBodyRegionUsEast1,
		api.V1CreateProjectBodyRegionEuCentral1,
	},
}, {
	Name:         "supabase-local",
	APIURL:       "http://localhost:8080",
	DashboardURL: "http://localhost:8082",
	DocsURL:      "https://supabase.com/docs",
	ProjectHost:  "supabase.red",
	ProjectRegions: []api.V1CreateProjectBodyRegion{
		api.V1CreateProjectBodyRegionApSoutheast1,
		api.V1CreateProjectBodyRegionUsEast1,
		api.V1CreateProjectBodyRegionEuCentral1,
	},
}, {
	Name:         "snap",
	APIURL:       "https://cloudapi.snap.com",
	DashboardURL: "https://cloud.snap.com/dashboard",
	DocsURL:      "https://cloud.snap.com/docs",
	ProjectHost:  "snapcloud.dev",
	PoolerHost:   "snapcloud.co",
	AuthClientID: "f7573b20-df47-48f1-b606-e8db4ec16252",
	ProjectRegions: []api.V1CreateProjectBodyRegion{
		api.V1CreateProjectBodyRegionUsEast1,
	},
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

func AwsRegions() []string {
	result := make([]string, len(allProfiles[0].ProjectRegions))
	for i, region := range allProfiles[0].ProjectRegions {
		result[i] = string(region)
	}
	sort.Strings(result)
	return result
}
