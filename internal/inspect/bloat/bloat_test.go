package bloat

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/testing/pgtest"

	"github.com/stretchr/testify/assert"
)

var dbConfig = pgconn.Config{
	Host:     "127.0.0.1",
	Port:     5432,
	User:     "admin",
	Password: "password",
	Database: "postgres",
}

func TestBloat(t *testing.T) {

	// Execute
	t.Run("bloat", func(t *testing.T) {
		mock := pgtest.NewConn()
		err := Run(context.Background(), dbConfig, afero.NewMemMapFs(), mock.Intercept)
		fmt.Println(err)
		assert.NoError(t, err)
	})

}
