package integration

// Basic imports
import (
	"context"
	"fmt"
	"net/http"
	"os"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"
	gonanoid "github.com/matoous/go-nanoid/v2"
	"github.com/spf13/cobra"
	"github.com/stretchr/testify/require"
	"github.com/stretchr/testify/suite"
	clicmd "github.com/supabase/cli/cmd"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/test/mocks/supabase"
)

type LinkTestSuite struct {
	suite.Suite
	tempDir string
	cmd     *cobra.Command

	ids     []string
	headers []http.Header

	mtx sync.RWMutex
}

// test functions
func (suite *LinkTestSuite) TestLink() {
	// run command
	link, _, err := suite.cmd.Find([]string{"link"})
	link.SetContext(context.Background())
	require.NoError(suite.T(), err)

	id := gonanoid.MustGenerate(supabase.IDAlphabet, supabase.IDLength)
	require.NoError(suite.T(), link.Flags().Set("project-ref", id))
	require.NoError(suite.T(), link.Flags().Set("password", "postgres"))

	require.NoError(suite.T(), link.RunE(link, []string{}))

	// check request details
	suite.mtx.RLock()
	defer suite.mtx.RUnlock()
	require.Contains(suite.T(), suite.ids, id)
	require.Contains(suite.T(), suite.headers, http.Header{
		"Authorization":   []string{fmt.Sprintf("Bearer %s", supabase.AccessToken)},
		"Accept-Encoding": []string{"gzip"},
		"User-Agent":      []string{"Go-http-client/1.1"},
	})
	_, err = os.Stat(utils.ProjectRefPath)
	require.NoError(suite.T(), err)
	ref, err := os.ReadFile(utils.ProjectRefPath)
	require.NoError(suite.T(), err)
	require.Equal(suite.T(), id, string(ref))
}

// hooks
func (suite *LinkTestSuite) SetupTest() {
	// init cli
	suite.cmd = clicmd.GetRootCmd()
	suite.tempDir = NewTempDir(Logger, TempDir)

	// init supabase
	init, _, err := suite.cmd.Find([]string{"init"})
	require.NoError(suite.T(), err)
	require.NoError(suite.T(), init.RunE(init, []string{}))

	// implement mocks
	SupaMock.FunctionsHandler = func(c *gin.Context) {
		suite.addHeaders(c.Request.Header)
		suite.addID(c.Params.ByName("id"))

		c.JSON(http.StatusOK, []api.FunctionResponse{})
	}
}

func (suite *LinkTestSuite) TeardownTest() {
	require.NoError(suite.T(), os.Chdir(TempDir))
}

// In order for 'go test' to run this suite, we need to create
// a normal test function and pass our suite to suite.Run
func TestLinkTestSuite(t *testing.T) {
	// suite.Run(t, new(LinkTestSuite))
}

// helper functions
func (suite *LinkTestSuite) addID(id string) {
	suite.mtx.Lock()
	defer suite.mtx.Unlock()
	suite.ids = append(suite.ids, id)
}

func (suite *LinkTestSuite) addHeaders(headers http.Header) {
	suite.mtx.Lock()
	defer suite.mtx.Unlock()
	suite.headers = append(suite.headers, headers)
}
