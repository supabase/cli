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

type EszipBundler interface {
	Bundle(ctx context.Context, slug, entrypoint, importMap string, staticFiles []string, output io.Writer) (api.FunctionDeployMetadata, error)
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
