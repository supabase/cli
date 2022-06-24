package integration

// Basic imports
import (
	"os"
	"testing"

	"github.com/spf13/cobra"
	"github.com/stretchr/testify/require"
	"github.com/stretchr/testify/suite"
	clicmd "github.com/supabase/cli/cmd"
)

type InitTestSuite struct {
	suite.Suite
	tempDir string
	cmd     *cobra.Command
}

// test functions
func (suite *InitTestSuite) TestInit() {
	// init supabase
	init, _, err := suite.cmd.Find([]string{"init"})
	require.NoError(suite.T(), err)
	require.NoError(suite.T(), init.RunE(init, []string{}))

	// check if init dir exists
	_, err = os.Stat("supabase/config.toml")
	require.NoError(suite.T(), err)
}

// hooks
func (suite *InitTestSuite) SetupTest() {
	// init cli
	suite.cmd = clicmd.NewRootCmd()
	suite.tempDir = NewTempDir(Logger, TempDir)
}

func (suite *InitTestSuite) TeardownTest() {
	require.NoError(suite.T(), os.Chdir(TempDir))
}

// In order for 'go test' to run this suite, we need to create
// a normal test function and pass our suite to suite.Run
func TestInitTestSuite(t *testing.T) {
	suite.Run(t, new(InitTestSuite))
}
