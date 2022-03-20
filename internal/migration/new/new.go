package new

import (
	"os"

	"github.com/supabase/cli/internal/utils"
)

func Run(migrationName string) error {
	if err := utils.AssertSupabaseCliIsSetUp(); err != nil {
		return err
	}

	if err := utils.MkdirIfNotExist("supabase/migrations"); err != nil {
		return err
	}

	timestamp := utils.GetCurrentTimestamp()
	return os.WriteFile("supabase/migrations/"+timestamp+"_"+migrationName+".sql", []byte{}, 0644)
}
