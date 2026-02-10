#!/bin/bash
# Run TimGUITests using xcodebuild

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAC_DIR="$(dirname "$SCRIPT_DIR")"

cd "$MAC_DIR"

ARCH="arm64"
CONFIGURATION="Debug"
DESTINATION="platform=macOS,arch=$ARCH"

echo "Running TimGUITests..."
echo "Configuration: $CONFIGURATION"
echo "Architecture: $ARCH"

# Check if xcbeautify is available
if command -v xcbeautify &> /dev/null; then
    xcodebuild \
        -project TimGUI.xcodeproj \
        -scheme TimGUI \
        -configuration "$CONFIGURATION" \
        -destination "$DESTINATION" \
        -only-testing:TimGUITests \
        test | xcbeautify
else
    xcodebuild \
        -project TimGUI.xcodeproj \
        -scheme TimGUI \
        -configuration "$CONFIGURATION" \
        -destination "$DESTINATION" \
        -only-testing:TimGUITests \
        test
fi

echo "Tests complete."
