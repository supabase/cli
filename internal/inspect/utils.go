package inspect

import (
	"embed"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/db/reset"
	"github.com/supabase/cli/internal/utils"
)

const ROOT_DIR = "queries/"
const CSV_QUERY = `COPY (%s) TO STDOUT WITH CSV HEADER`

//go:embed queries/*.sql
var queries embed.FS

func ReadQuery(query string) string {
	path := fmt.Sprintf("%s%s.sql", ROOT_DIR, query)
	queryString, err := queries.ReadFile(path)
	if err != nil {
		println(err.Error())
		return ""
	}
	return string(queryString)
}

func Report(cmd *cobra.Command, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	queries, err := queries.ReadDir("queries")
	if err != nil {
		return err
	}
	date := time.Now().Format("2006-01-02")
	out, err := cmd.Flags().GetString("out-path")
	if err != nil {
		return err
	}
	if out != "" {
		err := os.MkdirAll(out, os.ModePerm)
		if err != nil {
			return errors.Errorf("failed to create output directory: %w", err)
		}
	} else {
		out = "./"
	}
	fmt.Println("Running queries...")
	for _, v := range queries {
		name := strings.Split(v.Name(), ".")[0]
		query := ReadQuery(name)
		fq := strings.Replace(query, "$1", "'{"+strings.Join(reset.LikeEscapeSchema(utils.InternalSchemas), ",")+"}'::text[]", -1)
		copyCmd := fmt.Sprintf(`COPY (%s) TO STDOUT WITH CSV HEADER`, fq)
		// gosec lint error is unavoidable here because of formatted params
		cmd := exec.CommandContext(cmd.Context(), "psql", utils.ToPostgresURL(config), "-At", "-F\",\"", "-c", copyCmd, "-o", fmt.Sprintf("%s/%s_%s.csv", out, name, date)) //nolint:gosec
		if err := cmd.Run(); err != nil {
			return errors.Errorf("failed to run query: %w", err)
		}
	}
	fmt.Printf("Reports saved to %s/", out)
	return nil
}
