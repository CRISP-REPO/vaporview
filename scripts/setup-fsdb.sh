#!/usr/bin/env bash
set -euo pipefail

# setup-fsdb.sh — Auto-detect Verdi/Xcelium and build the FSDB reader addon

# Determine FSDB root from environment
if [[ -n "${VERDI_HOME:-}" ]]; then
  FSDB_ROOT="$VERDI_HOME"
  echo "Found VERDI_HOME=$VERDI_HOME"
elif [[ -n "${XCELIUM_HOME:-}" ]]; then
  FSDB_ROOT="$XCELIUM_HOME"
  echo "Found XCELIUM_HOME=$XCELIUM_HOME"
else
  echo "Error: Neither VERDI_HOME nor XCELIUM_HOME is set."
  echo "Please set VERDI_HOME to your Synopsys Verdi installation directory."
  echo "  export VERDI_HOME=/path/to/verdi/<version>"
  exit 1
fi

# Resolve library and header paths
FSDB_LIBS_PATH="$FSDB_ROOT/share/FsdbReader/linux64"
FSDB_HEADER_PATH="$FSDB_ROOT/share/FsdbReader"

# If using XCELIUM_HOME, also check the Xcelium-specific paths
if [[ -z "${VERDI_HOME:-}" && -n "${XCELIUM_HOME:-}" ]]; then
  if [[ ! -d "$FSDB_LIBS_PATH" ]]; then
    FSDB_LIBS_PATH="$XCELIUM_HOME/tools.lnx86/lib/64bit"
  fi
  if [[ ! -f "$FSDB_HEADER_PATH/ffrAPI.h" ]]; then
    FSDB_HEADER_PATH="$XCELIUM_HOME/tools.lnx86/include"
  fi
fi

# Validate required files
MISSING=0

if [[ ! -f "$FSDB_LIBS_PATH/libnffr.so" ]]; then
  echo "Error: libnffr.so not found at $FSDB_LIBS_PATH/"
  MISSING=1
fi

if [[ ! -f "$FSDB_LIBS_PATH/libnsys.so" ]]; then
  echo "Error: libnsys.so not found at $FSDB_LIBS_PATH/"
  MISSING=1
fi

if [[ ! -f "$FSDB_HEADER_PATH/ffrAPI.h" ]]; then
  echo "Error: ffrAPI.h not found at $FSDB_HEADER_PATH/"
  MISSING=1
fi

if [[ $MISSING -ne 0 ]]; then
  echo ""
  echo "Required FSDB Reader files are missing. Please verify your installation."
  exit 1
fi

echo "FSDB libraries: $FSDB_LIBS_PATH"
echo "FSDB headers:   $FSDB_HEADER_PATH"

# Generate binding.gyp from the disabled template with detected paths
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cat > "$PROJECT_DIR/binding.gyp" <<EOF
{
  "variables": {
    "FSDB_READER_LIBS_PATH": "$FSDB_LIBS_PATH",
    "FSDB_HEADER_PATH": "$FSDB_HEADER_PATH"
  },
  "targets": [
    {
      "target_name": "fsdb_reader",
      "cflags!": [ "-fno-exceptions" ],
      "cflags": [ "-fPIC" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "cflags_cc": [ "-fPIC" ],
      "sources": [ "src/fsdb_reader.cpp" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<(FSDB_HEADER_PATH)>"
      ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "ldflags": [
        "-L<(FSDB_READER_LIBS_PATH)>",
        "-static-libstdc++"
      ],
      "libraries": [
        "-lnffr",
        "-lnsys"
      ]
    }
  ]
}
EOF

echo "Generated binding.gyp"

# Build the native addon
echo "Building fsdb_reader.node..."
cd "$PROJECT_DIR"
npx node-gyp rebuild

echo ""
echo "FSDB reader addon built successfully: build/Release/fsdb_reader.node"
