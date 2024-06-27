package utils

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/docker/docker/pkg/jsonmessage"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/go-errors/errors"
)

func ProcessPullOutput(out io.ReadCloser, p Program) error {
	dec := json.NewDecoder(out)

	downloads := make(map[string]struct{ current, total int64 })

	for {
		var progress jsonmessage.JSONMessage

		if err := dec.Decode(&progress); err == io.EOF {
			break
		} else if err != nil {
			return err
		}

		if strings.HasPrefix(progress.Status, "Pulling from") {
			p.Send(StatusMsg(progress.Status + "..."))
		} else if progress.Status == "Pulling fs layer" || progress.Status == "Waiting" {
			downloads[progress.ID] = struct{ current, total int64 }{
				current: 0,
				total:   0,
			}
		} else if progress.Status == "Downloading" {
			downloads[progress.ID] = struct{ current, total int64 }{
				current: progress.Progress.Current,
				total:   progress.Progress.Total,
			}

			var overallProgress float64
			for _, percentage := range downloads {
				if percentage.total > 0 {
					progress := float64(percentage.current) / float64(percentage.total)
					overallProgress += progress / float64(len(downloads))
				}
			}

			p.Send(ProgressMsg(&overallProgress))
		}
	}

	p.Send(ProgressMsg(nil))

	return nil
}

type DiffStream struct {
	o bytes.Buffer
	r *io.PipeReader
	w *io.PipeWriter
	p Program
}

func NewDiffStream(p Program) *DiffStream {
	r, w := io.Pipe()
	go func() {
		if err := ProcessDiffProgress(p, r); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}()
	return &DiffStream{r: r, w: w, p: p}
}

func (c DiffStream) Stdout() io.Writer {
	return &c.o
}

func (c DiffStream) Stderr() io.Writer {
	return c.w
}

func (c DiffStream) Collect() ([]byte, error) {
	if err := c.w.Close(); err != nil {
		fmt.Fprintln(os.Stderr, "Failed to close stream:", err)
	}
	return ProcessDiffOutput(c.o.Bytes())
}

func ProcessDiffProgress(p Program, out io.Reader) error {
	scanner := bufio.NewScanner(out)
	re := regexp.MustCompile(`(.*)([[:digit:]]{2,3})%`)
	for scanner.Scan() {
		line := scanner.Text()

		if line == "Starting schema diff..." {
			percentage := 0.0
			p.Send(ProgressMsg(&percentage))
		}

		matches := re.FindStringSubmatch(line)
		if len(matches) != 3 {
			// TODO: emit actual error statements
			continue
		}

		p.Send(StatusMsg(matches[1]))
		percentage, err := strconv.ParseFloat(matches[2], 64)
		if err != nil {
			continue
		}
		percentage = percentage / 100
		p.Send(ProgressMsg(&percentage))
	}
	p.Send(ProgressMsg(nil))
	return scanner.Err()
}

type DiffDependencies struct {
	Type string `json:"type"`
}

type DiffEntry struct {
	Type             string             `json:"type"`
	Status           string             `json:"status"`
	DiffDdl          string             `json:"diff_ddl"`
	GroupName        string             `json:"group_name"`
	Dependencies     []DiffDependencies `json:"dependencies"`
	SourceSchemaName *string            `json:"source_schema_name"`
}

const diffHeader = `-- This script was generated by the Schema Diff utility in pgAdmin 4
-- For the circular dependencies, the order in which Schema Diff writes the objects is not very sophisticated
-- and may require manual changes to the script to ensure changes are applied in the correct order.
-- Please report an issue for any failure with the reproduction steps.`

func ProcessDiffOutput(diffBytes []byte) ([]byte, error) {
	// TODO: Remove when https://github.com/supabase/pgadmin4/issues/24 is fixed.
	diffBytes = bytes.TrimPrefix(diffBytes, []byte("NOTE: Configuring authentication for DESKTOP mode.\n"))

	if len(diffBytes) == 0 {
		return diffBytes, nil
	}

	var diffJson []DiffEntry
	if err := json.Unmarshal(diffBytes, &diffJson); err != nil {
		return nil, err
	}

	var filteredDiffDdls []string
	for _, diffEntry := range diffJson {
		if diffEntry.Status == "Identical" || diffEntry.DiffDdl == "" {
			continue
		}

		switch diffEntry.Type {
		case "extension", "function", "mview", "table", "trigger_function", "type", "view":
			// skip
		default:
			continue
		}

		{
			doContinue := false
			for _, dep := range diffEntry.Dependencies {
				if dep.Type == "extension" {
					doContinue = true
					break
				}
			}

			if doContinue {
				continue
			}
		}

		isSchemaIgnored := func(schema string) bool {
			for _, s := range InternalSchemas {
				if s == schema {
					return true
				}
			}
			return false
		}

		if isSchemaIgnored(diffEntry.GroupName) ||
			// Needed at least for trigger_function
			(diffEntry.SourceSchemaName != nil && isSchemaIgnored(*diffEntry.SourceSchemaName)) {
			continue
		}

		trimmed := strings.TrimSpace(diffEntry.DiffDdl)
		if len(trimmed) > 0 {
			filteredDiffDdls = append(filteredDiffDdls, trimmed)
		}
	}

	if len(filteredDiffDdls) == 0 {
		return nil, nil
	}
	return []byte(diffHeader + "\n\n" + strings.Join(filteredDiffDdls, "\n\n") + "\n"), nil
}

func ProcessPsqlOutput(out io.Reader, p Program) error {
	r, w := io.Pipe()
	doneCh := make(chan struct{}, 1)

	go func() {
		scanner := bufio.NewScanner(r)

		for scanner.Scan() {
			select {
			case <-doneCh:
				return
			default:
			}

			line := scanner.Text()
			p.Send(PsqlMsg(&line))
		}
	}()

	var errBuf bytes.Buffer
	if _, err := stdcopy.StdCopy(w, &errBuf, out); err != nil {
		return err
	}
	if errBuf.Len() > 0 {
		return errors.New("Error running SQL: " + errBuf.String())
	}

	doneCh <- struct{}{}
	p.Send(PsqlMsg(nil))

	return nil
}
