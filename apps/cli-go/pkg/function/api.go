package function

import (
	"context"
	"io"

	"github.com/supabase/cli/pkg/api"
)

type EdgeRuntimeAPI struct {
	project string
	client  api.ClientWithResponses
	eszip   EszipBundler
	maxJobs uint
}

type FunctionDeployMetadata struct {
	EntrypointPath string    `json:"entrypoint_path"`
	ImportMapPath  *string   `json:"import_map_path,omitempty"`
	Name           *string   `json:"name,omitempty"`
	StaticPatterns *[]string `json:"static_patterns,omitempty"`
	VerifyJwt      *bool     `json:"verify_jwt,omitempty"`
	SHA256         string    `json:"sha256,omitempty"`
}

type EszipBundler interface {
	Bundle(ctx context.Context, slug, entrypoint, importMap string, staticFiles []string, output io.Writer) (FunctionDeployMetadata, error)
}

func NewEdgeRuntimeAPI(project string, client api.ClientWithResponses, opts ...withOption) EdgeRuntimeAPI {
	result := EdgeRuntimeAPI{client: client, project: project}
	for _, apply := range opts {
		apply(&result)
	}
	if result.maxJobs == 0 {
		result.maxJobs = 1
	}
	return result
}

type withOption func(*EdgeRuntimeAPI)

func WithBundler(bundler EszipBundler) withOption {
	return func(era *EdgeRuntimeAPI) {
		era.eszip = bundler
	}
}

func WithMaxJobs(maxJobs uint) withOption {
	return func(era *EdgeRuntimeAPI) {
		era.maxJobs = maxJobs
	}
}
