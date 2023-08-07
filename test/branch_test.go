package integration

import (
	"encoding/json"
	"os"

	"github.com/docker/docker/api/types"
	"github.com/stretchr/testify/require"
)

// this is the part of Database test suite - DBTestSuite
// test functions
func (suite *DBTestSuite) TestBranchCreate() {
	suite.T().Skip("Local branching is deprecated")
	// create branch
	branch := "test-branch"
	create, args, err := suite.cmd.Traverse([]string{"db", "branch", "create", branch})
	if err != nil {
		suite.Fail("failed to find create command")
	}
	err = create.RunE(create, args)
	if err != nil {
		suite.Fail("failed to create branch", err)
	}

	// check if branch dir exists
	_, err = os.Stat("supabase/.branches/" + branch)
	require.NoError(suite.T(), err)

	// check if all exec calls were made to docker api
	ids := suite.constructParams()
	require.ElementsMatch(suite.T(), suite.params, ids)

	// check commands in exec calls
	require.Equal(suite.T(), 2, len(suite.bodies))
	var execBody types.ExecConfig
	require.NoError(suite.T(), json.Unmarshal([]byte(suite.bodies[0]), &execBody))
	var startBody types.ExecStartCheck
	require.NoError(suite.T(), json.Unmarshal([]byte(suite.bodies[1]), &startBody))
}
