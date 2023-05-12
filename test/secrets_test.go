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
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/test/mocks/supabase"
)

type SecretsTestSuite struct {
	suite.Suite
	tempDir string
	cmd     *cobra.Command

	ids     []string
	headers []http.Header

	mtx sync.RWMutex
}

// test functions
func (suite *SecretsTestSuite) TestList() {
	// run command
	list, _, err := suite.cmd.Find([]string{"secrets", "list"})
	list.SetContext(context.Background())
	require.NoError(suite.T(), err)

	// set stdout to write into file so we can capture cmd output
	tmpfile, err := os.CreateTemp(suite.tempDir, "output")
	require.NoError(suite.T(), err)
	defer os.Remove(tmpfile.Name()) // clean up
	oldStdout := os.Stdout
	defer func() { os.Stdout = oldStdout }()
	os.Stdout = tmpfile

	flags.ProjectRef = gonanoid.MustGenerate(supabase.IDAlphabet, supabase.IDLength)
	require.NoError(suite.T(), list.RunE(list, []string{}))

	// check request details
	suite.mtx.RLock()
	defer suite.mtx.RUnlock()
	require.Contains(suite.T(), suite.ids, flags.ProjectRef)
	require.Contains(suite.T(), suite.headers, http.Header{
		"Authorization":   []string{fmt.Sprintf("Bearer %s", supabase.AccessToken)},
		"Accept-Encoding": []string{"gzip"},
		"User-Agent":      []string{"SupabaseCLI/"},
	})

	contents, err := os.ReadFile(tmpfile.Name())
	require.NoError(suite.T(), err)
	require.Contains(suite.T(), string(contents), "some-key")
	require.Contains(suite.T(), string(contents), "another")
}

// hooks
func (suite *SecretsTestSuite) SetupTest() {
	// init cli
	suite.cmd = clicmd.GetRootCmd()
	suite.tempDir = NewTempDir(Logger, TempDir)

	// init supabase
	init, _, err := suite.cmd.Find([]string{"init"})
	require.NoError(suite.T(), err)
	require.NoError(suite.T(), init.RunE(init, []string{}))

	// add `link` dir
	require.NoError(suite.T(), os.MkdirAll("supabase/.temp", os.FileMode(0755)))

	// implement mocks
	SupaMock.SecretsHandler = func(c *gin.Context) {
		suite.addHeaders(c.Request.Header)
		suite.addID(c.Params.ByName("id"))

		c.JSON(http.StatusOK, []gin.H{
			{
				"Name":  "some-key",
				"Value": gonanoid.Must(),
			},
			{
				"Name":  "another",
				"Value": gonanoid.Must(),
			},
		})
	}
}

func (suite *SecretsTestSuite) TeardownTest() {
	require.NoError(suite.T(), os.Chdir(TempDir))
}

// In order for 'go test' to run this suite, we need to create
// a normal test function and pass our suite to suite.Run
func TestSecretsTestSuite(t *testing.T) {
	suite.Run(t, new(SecretsTestSuite))
}

// helper functions
func (suite *SecretsTestSuite) addID(id string) {
	suite.mtx.Lock()
	defer suite.mtx.Unlock()
	suite.ids = append(suite.ids, id)
}

func (suite *SecretsTestSuite) addHeaders(headers http.Header) {
	suite.mtx.Lock()
	defer suite.mtx.Unlock()
	suite.headers = append(suite.headers, headers)
}
