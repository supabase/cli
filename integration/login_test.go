package integration

// Basic imports
import (
	"io/ioutil"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"
	gonanoid "github.com/matoous/go-nanoid/v2"
	"github.com/spf13/cobra"
	"github.com/stretchr/testify/require"
	"github.com/stretchr/testify/suite"
	clicmd "github.com/supabase/cli/cmd"
	"github.com/supabase/cli/integration/mocks/supabase"
)

type LoginTestSuite struct {
	suite.Suite
	tempDir string
	cmd     *cobra.Command

	ids     []string
	headers []http.Header

	mtx sync.RWMutex
}

// test functions
func (suite *LoginTestSuite) TestLink() {
	// run command
	login, _, err := suite.cmd.Find([]string{"login"})
	require.NoError(suite.T(), err)
	key := "sbp_" + gonanoid.MustGenerate(supabase.KeyAlphabet, supabase.KeyLength)

	// change stdin to read from a file
	content := []byte(key)
	tmpfile, err := ioutil.TempFile(suite.tempDir, "key")
	require.NoError(suite.T(), err)
	defer os.Remove(tmpfile.Name()) // clean up

	_, err = tmpfile.Write(content)
	require.NoError(suite.T(), err)
	_, err = tmpfile.Seek(0, 0)
	require.NoError(suite.T(), err)

	oldStdin := os.Stdin
	defer func() { os.Stdin = oldStdin }()
	os.Stdin = tmpfile

	require.NoError(suite.T(), login.RunE(login, []string{}))

	// check token is saved
	home, err := os.UserHomeDir()
	require.NoError(suite.T(), err)
	_, err = os.Stat(filepath.Join(home, ".supabase/access-token"))
	require.NoError(suite.T(), err)
	token, err := ioutil.ReadFile(filepath.Join(home, ".supabase/access-token"))
	require.NoError(suite.T(), err)
	require.Equal(suite.T(), key, string(token))
}

// hooks
func (suite *LoginTestSuite) SetupTest() {
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

		c.JSON(http.StatusOK, gin.H{})
	}
}

func (suite *LoginTestSuite) TeardownTest() {
	require.NoError(suite.T(), os.Chdir(TempDir))
}

// In order for 'go test' to run this suite, we need to create
// a normal test function and pass our suite to suite.Run
func TestLoginTestSuite(t *testing.T) {
	suite.Run(t, new(LoginTestSuite))
}

// helper functions
func (suite *LoginTestSuite) addID(id string) {
	suite.mtx.Lock()
	defer suite.mtx.Unlock()
	suite.ids = append(suite.ids, id)
}

func (suite *LoginTestSuite) addHeaders(headers http.Header) {
	suite.mtx.Lock()
	defer suite.mtx.Unlock()
	suite.headers = append(suite.headers, headers)
}
