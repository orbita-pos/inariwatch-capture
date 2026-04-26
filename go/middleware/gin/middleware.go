// Package gin — optional gin-gonic middleware for inariwatch-capture.
//
// This subpackage imports github.com/gin-gonic/gin, so the core module
// doesn't pay for gin unless you actually use it. Build with
// ``go get github.com/gin-gonic/gin`` in your app to resolve the dep.
//
//go:build capture_gin

package gin

// Placeholder — fleshed out when gin is in the dependency graph.
// We ship the build tag as ``capture_gin`` so tests that don't enable
// it don't need gin on GOPATH. Users opt in via
// ``go build -tags capture_gin ./...``.
