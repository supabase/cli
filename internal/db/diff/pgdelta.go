package diff

import (
	"bytes"
	"context"
	_ "embed"
	"strings"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/supabase/cli/internal/gen/types"
	"github.com/supabase/cli/internal/utils"
)

//go:embed templates/pgdelta.ts
var pgDeltaScript string

func DiffPgDelta(ctx context.Context, source, target pgconn.Config, schema []string, options ...func(*pgx.ConnConfig)) (string, error) {
	env := []string{
		"SOURCE=" + utils.ToPostgresURL(source),
	}
	if ca, err := types.GetRootCA(ctx, utils.ToPostgresURL(target), options...); err != nil {
		return "", err
	} else if len(ca) > 0 {
		target.RuntimeParams["sslmode"] = "require"
		env = append(env,
			"TARGET="+utils.ToPostgresURL(target),
			"PGDELTA_TARGET_SSLROOTCERT="+ca,
		)
	}
	if len(schema) > 0 {
		env = append(env, "INCLUDED_SCHEMAS="+strings.Join(schema, ","))
	}
	var out bytes.Buffer
	if err := diffWithStream(ctx, env, pgDeltaScript, &out); err != nil {
		return "", err
	}
	return out.String(), nil
}
