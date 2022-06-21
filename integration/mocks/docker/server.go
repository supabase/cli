package docker

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

const (
	IDAlphabet = "abcdef0123456789"
	IDLength   = 12
)

// Server struct with route handlers
type Server struct {
	ContainerInspectHandler func(c *gin.Context)
	ExecCreateHandler       func(c *gin.Context)
	ExecStartHandler        func(c *gin.Context)
}

var defaultHandler = func(c *gin.Context) {
	c.JSON(http.StatusNotImplemented, gin.H{
		"message": "Not implemented",
	})
}

// NewServer creates a new server with default handlers
func NewServer() *Server {
	s := Server{
		ExecCreateHandler:       defaultHandler,
		ExecStartHandler:        defaultHandler,
		ContainerInspectHandler: defaultHandler,
	}
	return &s
}

// NewRouter creating a new router and setting the routes for the server.
func (s *Server) NewRouter() *gin.Engine {
	root := gin.Default()
	router := root.Group("/v1.41")

	containers := router.Group("/containers")
	containers.GET("/:id/json", s.inspectContainer)
	containers.POST("/:id/exec", s.createExec)

	exec := router.Group("/exec")
	exec.POST("/:id/start", s.startExec)

	return root
}

// container
func (s *Server) inspectContainer(c *gin.Context) {
	if s.ContainerInspectHandler == nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"message": "handler is nil",
		})
	}
	s.ContainerInspectHandler(c)
}

// exec
func (s *Server) createExec(c *gin.Context) {
	if s.ExecCreateHandler == nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"message": "handler is nil",
		})
	}
	s.ExecCreateHandler(c)
}

func (s *Server) startExec(c *gin.Context) {
	if s.ExecStartHandler == nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"message": "handler is nil",
		})
	}
	s.ExecStartHandler(c)
}
