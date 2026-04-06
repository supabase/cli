package query

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWriteJSONWithAdvisory(t *testing.T) {
	advisory := &Advisory{
		ID:             "rls_disabled",
		Priority:       1,
		Level:          "critical",
		Title:          "Row Level Security is disabled",
		Message:        "1 table(s) do not have RLS enabled: public.test.",
		RemediationSQL: "ALTER TABLE public.test ENABLE ROW LEVEL SECURITY;",
		DocURL:         "https://supabase.com/docs/guides/database/postgres/row-level-security",
	}

	cols := []string{"id", "name"}
	data := [][]interface{}{{int64(1), "test"}}

	var buf bytes.Buffer
	err := writeJSON(&buf, cols, data, true, advisory)
	assert.NoError(t, err)

	var envelope map[string]interface{}
	require.NoError(t, json.Unmarshal(buf.Bytes(), &envelope))

	// Verify standard envelope fields
	assert.Contains(t, envelope["warning"], "untrusted data")
	assert.NotEmpty(t, envelope["boundary"])
	rows, ok := envelope["rows"].([]interface{})
	require.True(t, ok)
	assert.Len(t, rows, 1)

	// Verify advisory is present
	advisoryMap, ok := envelope["advisory"].(map[string]interface{})
	require.True(t, ok)
	assert.Equal(t, "rls_disabled", advisoryMap["id"])
	assert.Equal(t, float64(1), advisoryMap["priority"])
	assert.Equal(t, "critical", advisoryMap["level"])
	assert.Contains(t, advisoryMap["message"], "public.test")
	assert.Contains(t, advisoryMap["remediation_sql"], "ENABLE ROW LEVEL SECURITY")
	assert.Contains(t, advisoryMap["doc_url"], "row-level-security")
}

func TestWriteJSONWithoutAdvisory(t *testing.T) {
	cols := []string{"id"}
	data := [][]interface{}{{int64(1)}}

	var buf bytes.Buffer
	err := writeJSON(&buf, cols, data, true, nil)
	assert.NoError(t, err)

	var envelope map[string]interface{}
	require.NoError(t, json.Unmarshal(buf.Bytes(), &envelope))

	// Verify advisory is NOT present
	_, exists := envelope["advisory"]
	assert.False(t, exists)
}

func TestWriteJSONNonAgentModeNoAdvisory(t *testing.T) {
	advisory := &Advisory{
		ID:             "rls_disabled",
		Priority:       1,
		Level:          "critical",
		Title:          "Row Level Security is disabled",
		Message:        "test",
		RemediationSQL: "test",
		DocURL:         "test",
	}

	cols := []string{"id"}
	data := [][]interface{}{{int64(1)}}

	var buf bytes.Buffer
	err := writeJSON(&buf, cols, data, false, advisory)
	assert.NoError(t, err)

	// Non-agent mode: plain JSON array, no envelope or advisory
	var rows []map[string]interface{}
	require.NoError(t, json.Unmarshal(buf.Bytes(), &rows))
	assert.Len(t, rows, 1)
}

func TestFormatOutputThreadsAdvisory(t *testing.T) {
	advisory := &Advisory{
		ID:             "rls_disabled",
		Priority:       1,
		Level:          "critical",
		Title:          "test",
		Message:        "test",
		RemediationSQL: "test",
		DocURL:         "test",
	}

	cols := []string{"id"}
	data := [][]interface{}{{int64(1)}}

	// JSON agent mode should include advisory
	var buf bytes.Buffer
	err := formatOutput(&buf, "json", true, cols, data, advisory)
	assert.NoError(t, err)

	var envelope map[string]interface{}
	require.NoError(t, json.Unmarshal(buf.Bytes(), &envelope))
	_, exists := envelope["advisory"]
	assert.True(t, exists)
}

func TestFormatOutputCSVIgnoresAdvisory(t *testing.T) {
	advisory := &Advisory{
		ID:             "rls_disabled",
		Priority:       1,
		Level:          "critical",
		Title:          "test",
		Message:        "test",
		RemediationSQL: "test",
		DocURL:         "test",
	}

	cols := []string{"id"}
	data := [][]interface{}{{int64(1)}}

	// CSV format should not include advisory (CSV has no envelope)
	var buf bytes.Buffer
	err := formatOutput(&buf, "csv", false, cols, data, advisory)
	assert.NoError(t, err)
	assert.Contains(t, buf.String(), "id")
	assert.Contains(t, buf.String(), "1")
	assert.NotContains(t, buf.String(), "advisory")
}

func TestFormatOutputTableIgnoresAdvisory(t *testing.T) {
	advisory := &Advisory{
		ID:             "rls_disabled",
		Priority:       1,
		Level:          "critical",
		Title:          "test",
		Message:        "test",
		RemediationSQL: "test",
		DocURL:         "test",
	}

	cols := []string{"id"}
	data := [][]interface{}{{int64(1)}}

	// Table format should not include advisory
	var buf bytes.Buffer
	err := formatOutput(&buf, "table", false, cols, data, advisory)
	assert.NoError(t, err)
	assert.NotContains(t, buf.String(), "advisory")
}
