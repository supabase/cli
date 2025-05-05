package utils

import (
	"bytes"
	"encoding/json"
	"io"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/docker/docker/pkg/jsonmessage"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestProcessDiffOutput(t *testing.T) {
	t.Run("processes valid diff entries", func(t *testing.T) {
		input := []DiffEntry{
			{
				Type:      "table",
				Status:    "Different",
				DiffDdl:   "ALTER TABLE test;",
				GroupName: "public",
			},
			{
				Type:      "extension",
				Status:    "Different",
				DiffDdl:   "CREATE EXTENSION test;",
				GroupName: "public",
			},
		}
		inputBytes, err := json.Marshal(input)
		require.NoError(t, err)

		output, err := ProcessDiffOutput(inputBytes)

		assert.NoError(t, err)
		assert.Contains(t, string(output), "ALTER TABLE test;")
		assert.Contains(t, string(output), "CREATE EXTENSION test;")
	})

	t.Run("filters out internal schemas", func(t *testing.T) {
		input := []DiffEntry{
			{
				Type:      "table",
				Status:    "Different",
				DiffDdl:   "ALTER TABLE test;",
				GroupName: "auth",
			},
			{
				Type:      "extension",
				Status:    "Different",
				DiffDdl:   "CREATE EXTENSION test;",
				GroupName: "auth",
			},
		}
		inputBytes, err := json.Marshal(input)
		require.NoError(t, err)

		output, err := ProcessDiffOutput(inputBytes)

		assert.NoError(t, err)
		assert.Nil(t, output)
	})
}

func TestProcessPsqlOutput(t *testing.T) {
	t.Run("processes psql output", func(t *testing.T) {
		var buf bytes.Buffer
		writer := stdcopy.NewStdWriter(&buf, stdcopy.Stdout)
		_, err := writer.Write([]byte("test output\n"))
		require.NoError(t, err)

		var lastLine *string
		p := NewMockProgram(func(msg tea.Msg) {
			if m, ok := msg.(PsqlMsg); ok {
				lastLine = m
			}
		})

		err = ProcessPsqlOutput(&buf, p)

		assert.NoError(t, err)
		assert.Nil(t, lastLine)
	})

	t.Run("handles stderr output", func(t *testing.T) {
		var buf bytes.Buffer
		writer := stdcopy.NewStdWriter(&buf, stdcopy.Stderr)
		_, err := writer.Write([]byte("error message\n"))
		require.NoError(t, err)

		p := NewMockProgram(nil)

		err = ProcessPsqlOutput(&buf, p)

		assert.Error(t, err)
		assert.Contains(t, err.Error(), "error message")
	})
}

func TestProcessPullOutput(t *testing.T) {
	t.Run("processes docker pull messages", func(t *testing.T) {
		messages := []jsonmessage.JSONMessage{
			{Status: "Pulling from library/postgres"},
			{ID: "layer1", Status: "Pulling fs layer"},
			{ID: "layer1", Status: "Downloading", Progress: &jsonmessage.JSONProgress{Current: 50, Total: 100}},
			{ID: "layer2", Status: "Pulling fs layer"},
			{ID: "layer2", Status: "Downloading", Progress: &jsonmessage.JSONProgress{Current: 75, Total: 100}},
		}

		// Create a pipe to write messages
		r, w := io.Pipe()
		enc := json.NewEncoder(w)
		go func() {
			for _, msg := range messages {
				err := enc.Encode(msg)
				assert.Nil(t, err)
			}
			w.Close()
		}()

		var status string
		var progressFirst *float64
		var progress *float64
		p := NewMockProgram(func(msg tea.Msg) {
			switch m := msg.(type) {
			case StatusMsg:
				status = string(m)
			case ProgressMsg:
				progress = m
				if progressFirst == nil {
					progressFirst = m
				}
			}
		})

		err := ProcessPullOutput(r, p)

		assert.NoError(t, err)
		assert.Equal(t, "Pulling from library/postgres...", status)
		assert.Equal(t, *progressFirst, 0.5)
		assert.Nil(t, progress)
	})
}

type MockProgram struct {
	handler func(tea.Msg)
}

func NewMockProgram(handler func(tea.Msg)) *MockProgram {
	return &MockProgram{handler: handler}
}

func (m *MockProgram) Start() error {
	return nil
}

func (m *MockProgram) Send(msg tea.Msg) {
	if m.handler != nil {
		m.handler(msg)
	}
}

func (m *MockProgram) Quit() {}
