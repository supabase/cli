package inspect

import (
	"embed"
	"fmt"
	"os/exec"
	"strings"

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
	fmt.Println("Running queries...")
	for _, v := range queries {
		name := strings.Split(v.Name(), ".")[0]
		query := ReadQuery(name)
		fq := strings.Replace(query, "$1", "'{"+strings.Join(reset.LikeEscapeSchema(utils.InternalSchemas), ",")+"}'::text[]", -1)
		copyCmd := fmt.Sprintf(`COPY (%s) TO STDOUT WITH CSV HEADER`, fq)
		cmd := exec.CommandContext(cmd.Context(), "psql", utils.ToPostgresURL(config), "-At", "-F\",\"", "-c", copyCmd, "-o", fmt.Sprintf("%s.csv", name))
		if err := cmd.Run(); err != nil {
			return err
		}
		// fmt.Printf("Output of %s saved to %s.csv\n", name, name)
	}
	fmt.Println("Reports saved!")
	return nil
}
