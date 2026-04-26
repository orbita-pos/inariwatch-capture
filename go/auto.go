package capture

// Auto exposes an import-side-effect style init for apps that prefer
// env-driven setup. Use in main.go:
//
//	import _ "github.com/orbita-pos/inariwatch-capture-go/auto"
//
// The sub-package lives under capture/go/auto/ so users who want the
// side-effect opt into it explicitly — blank-importing the core
// ``capture`` package would surprise folks used to Go's "imports have
// no side effects" convention.
