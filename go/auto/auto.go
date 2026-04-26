// Package auto — blank-import this package to initialize
// inariwatch-capture from environment variables.
//
//	import _ "github.com/orbita-pos/inariwatch-capture-go/auto"
//
// Reads:
//
//	INARIWATCH_DSN
//	INARIWATCH_ENVIRONMENT (fallback: GO_ENV, APP_ENV)
//	INARIWATCH_RELEASE
package auto

import capture "github.com/orbita-pos/inariwatch-capture-go"

func init() {
	capture.Init(capture.Config{})
}
