package utils

import (
	"encoding/json"
	"io"
	"strings"

	"github.com/docker/docker/pkg/jsonmessage"
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
