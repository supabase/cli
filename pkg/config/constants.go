package config

import (
	_ "embed"
	"regexp"

	"github.com/go-errors/errors"
	"github.com/go-viper/mapstructure/v2"
)

const (
	pg13  = "supabase/postgres:13.3.0"
	pg14  = "supabase/postgres:14.1.0.89"
	pg15  = "supabase/postgres:15.8.1.085"
	deno2 = "supabase/edge-runtime:v1.68.0-develop.18"
)

type images struct {
	Pg string `mapstructure:"pg"`
	// Append to Services when adding new dependencies below
	Kong        string `mapstructure:"kong"`
	Inbucket    string `mapstructure:"mailpit"`
	Postgrest   string `mapstructure:"postgrest"`
	Pgmeta      string `mapstructure:"pgmeta"`
	Studio      string `mapstructure:"studio"`
	ImgProxy    string `mapstructure:"imgproxy"`
	EdgeRuntime string `mapstructure:"edgeruntime"`
	Vector      string `mapstructure:"vector"`
	Supavisor   string `mapstructure:"supavisor"`
	Gotrue      string `mapstructure:"gotrue"`
	Realtime    string `mapstructure:"realtime"`
	Storage     string `mapstructure:"storage"`
	Logflare    string `mapstructure:"logflare"`
	// Append to Jobs when adding new dependencies below
	Differ  string `mapstructure:"differ"`
	Migra   string `mapstructure:"migra"`
	PgProve string `mapstructure:"pgprove"`
}

var (
	//go:embed templates/Dockerfile
	dockerImage  string
	imagePattern = regexp.MustCompile(`(?i)FROM\s+([^\s]+)\s+AS\s+([^\s]+)`)
	Images       images
)

func init() {
	matches := imagePattern.FindAllStringSubmatch(dockerImage, -1)
	result := make(map[string]string, len(matches))
	for _, m := range matches {
		if len(m) == 3 {
			result[m[2]] = m[1]
		}
	}
	if err := mapstructure.Decode(result, &Images); err != nil {
		panic(errors.Errorf("failed to decode images: %w", err))
	}
}

func (s images) Services() []string {
	return []string{
		s.Gotrue,
		s.Realtime,
		s.Storage,
		s.ImgProxy,
		s.Kong,
		s.Inbucket,
		s.Postgrest,
		s.Pgmeta,
		s.Studio,
		s.EdgeRuntime,
		s.Logflare,
		s.Vector,
		s.Supavisor,
	}
}
