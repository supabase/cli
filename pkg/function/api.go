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
}

type EszipBundler interface {
	Bundle(ctx context.Context, entrypoint string, importMap string, output io.Writer) error
}

func NewEdgeRuntimeAPI(project string, client api.ClientWithResponses, bundler EszipBundler) EdgeRuntimeAPI {
	return EdgeRuntimeAPI{client: client, project: project, eszip: bundler}
}
