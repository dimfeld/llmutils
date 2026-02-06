#!/bin/bash
# Adapted from https://github.com/amantus-ai/vibetunnel/blob/main/mac/scripts/build.sh

set -exuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAC_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$MAC_DIR")"
BUILD_DIR="$MAC_DIR/build"

ARCH="arm64"
CONFIGURATION="Debug"

case "$ARCH" in
    arm64|x86_64)
        DESTINATION="platform=macOS,arch=$ARCH"
        ARCHS="$ARCH"
        ;;
    universal)
        DESTINATION="platform=macOS"
        ARCHS="arm64 x86_64"
        ;;
    *)
        echo "Unknown architecture: $ARCH"
        usage
        exit 1
        ;;
esac

echo "Building TimGUI..."
echo "Configuration: $CONFIGURATION"
echo "Architecture: $ARCH"

mkdir -p "$BUILD_DIR"

# Use Xcode's default derived data path to preserve Swift package resolution
# Only use custom path if explicitly requested or in CI
if [[ "${CI:-false}" == "true" ]] || [[ "${USE_CUSTOM_DERIVED_DATA:-false}" == "true" ]]; then
    DERIVED_DATA_ARG="-derivedDataPath $BUILD_DIR"
    echo "Using custom derived data path: $BUILD_DIR"
else
    # Use default derived data, but still put build products in our build dir
    DERIVED_DATA_ARG=""
    echo "Using Xcode's default derived data path (preserves Swift packages)"
fi

# Check if xcbeautify is available
if command -v xcbeautify &> /dev/null; then
    echo "🔨 Building $ARCH binary with xcbeautify..."
    xcodebuild \
        -project TimGUI.xcodeproj \
        -scheme TimGUI \
        -configuration "$CONFIGURATION" \
        $DERIVED_DATA_ARG \
        -destination "$DESTINATION" \
        ARCHS="$ARCHS" \
        ONLY_ACTIVE_ARCH=NO \
        build | xcbeautify
else
    echo "🔨 Building $ARCH binary (install xcbeautify for cleaner output)..."
    xcodebuild \
        -project TimGUI.xcodeproj \
        -scheme TimGUI \
        -configuration "$CONFIGURATION" \
        $DERIVED_DATA_ARG \
        -destination "$DESTINATION" \
        ARCHS="$ARCHS" \
        ONLY_ACTIVE_ARCH=NO \
        build
fi

# Find the app in the appropriate location
if [[ "${CI:-false}" == "true" ]] || [[ "${USE_CUSTOM_DERIVED_DATA:-false}" == "true" ]]; then
    APP_PATH="$BUILD_DIR/Build/Products/$CONFIGURATION/TimGUI.app"
else
    # When using default derived data, get the build product path from xcodebuild
    DEFAULT_DERIVED_DATA="$HOME/Library/Developer/Xcode/DerivedData"
    # Find the most recent TimGUI build (exclude Index.noindex)
    APP_PATH=$(find "$DEFAULT_DERIVED_DATA" -name "TimGUI.app" -path "*/Build/Products/$CONFIGURATION/*" ! -path "*/Index.noindex/*" 2>/dev/null | head -n 1)
    
    if [[ -z "$APP_PATH" ]]; then
        # Fallback: try to get from xcode-select
        BUILT_PRODUCTS_DIR=$(xcodebuild -project TimGUI.xcodeproj -scheme TimGUI -configuration "$CONFIGURATION" -showBuildSettings | grep "BUILT_PRODUCTS_DIR" | head -n 1 | awk '{print $3}')
        if [[ -n "$BUILT_PRODUCTS_DIR" ]]; then
            APP_PATH="$BUILT_PRODUCTS_DIR/TimGUI.app"
        fi
    fi
fi

if [[ ! -d "$APP_PATH" ]]; then
    echo "Error: Build failed - app not found"
    echo "Searched in: ${APP_PATH:-various locations}"
    exit 1
fi

echo "Build complete: $APP_PATH"

# Print version info
VERSION=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$APP_PATH/Contents/Info.plist")
BUILD=$(/usr/libexec/PlistBuddy -c "Print CFBundleVersion" "$APP_PATH/Contents/Info.plist")
echo "Version: $VERSION ($BUILD)"
