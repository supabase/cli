package diff

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/utils"
)

func TestManagedDiffSchemas(t *testing.T) {
	t.Run("excludes base managed schemas when stripe sync disabled", func(t *testing.T) {
		utils.Config.StripeSync.Enabled = false
		schemas := managedDiffSchemas()
		assert.Equal(t, managedSchemas, schemas)
		assert.NotContains(t, schemas, "stripe")
	})

	t.Run("excludes stripe schema when stripe sync enabled", func(t *testing.T) {
		utils.Config.StripeSync.Enabled = true
		utils.Config.StripeSync.Schema = "stripe"
		t.Cleanup(func() { utils.Config.StripeSync.Enabled = false })
		schemas := managedDiffSchemas()
		assert.Contains(t, schemas, "stripe")
		// Base managed schemas are preserved and not mutated.
		assert.Subset(t, schemas, managedSchemas)
		assert.NotContains(t, managedSchemas, "stripe")
	})

	t.Run("respects a custom stripe schema name", func(t *testing.T) {
		utils.Config.StripeSync.Enabled = true
		utils.Config.StripeSync.Schema = "billing"
		t.Cleanup(func() {
			utils.Config.StripeSync.Enabled = false
			utils.Config.StripeSync.Schema = "stripe"
		})
		schemas := managedDiffSchemas()
		assert.Contains(t, schemas, "billing")
	})
}
