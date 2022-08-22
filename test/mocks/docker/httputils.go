package docker

import (
	"fmt"
	"io"
	"net/http"

	"github.com/docker/docker/pkg/ioutils"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/gin-gonic/gin"
)

func CloseStreams(streams ...interface{}) {
	for _, stream := range streams {
		if tcpc, ok := stream.(interface {
			CloseWrite() error
		}); ok {
			_ = tcpc.CloseWrite()
		} else if closer, ok := stream.(io.Closer); ok {
			_ = closer.Close()
		}
	}
}

func HijackedResponse(c *gin.Context, exitCode string, output ...string) {
	// hijack the connection
	hijacker, ok := c.Writer.(http.Hijacker)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "error hijacking connection",
		})
		return
	}
	conn, _, err := hijacker.Hijack()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "error hijacking connection",
		})
		return
	}
	_, err = conn.Write([]byte{})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"message": "error hijacking connection",
		})
		return
	}

	// write success code signalizing that the connection is established and ready to stream data
	fmt.Fprintf(conn, "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.docker.raw-stream\r\n\r\n")

	// setup closer
	closer := func() error {
		CloseStreams(conn)
		return nil
	}

	// write some output if command suppose to write to stdout
	outStream := stdcopy.NewStdWriter(conn, stdcopy.Stdout)
	if len(output) > 0 {
		fmt.Fprint(outStream, output)
	}
	// finish with exit code and close stream and connection as the command is done
	fmt.Fprintf(outStream, "exit code %s", exitCode)
	rc := ioutils.NewReadCloserWrapper(conn, closer)
	rc.Close()
}
