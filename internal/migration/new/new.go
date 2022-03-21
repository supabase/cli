package new

import (
	"fmt"
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
	if err := os.WriteFile("supabase/migrations/"+timestamp+"_"+migrationName+".sql", []byte{}, 0644); err != nil {
		return err
	}

	fmt.Println("Created new migration at " + utils.Bold("supabase/migrations/"+timestamp+"_"+migrationName+".sql") + ".")
	return nil
}
