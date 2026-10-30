#!/bin/sh
# Builds the macOS notification helper, out/mac/Switchboard.app: a universal
# binary (Apple silicon and Intel), signed ad hoc. Needs the Xcode command
# line tools (xcode-select --install). The .vsix ships the built app, so
# people who install it need nothing.
set -eu
cd "$(dirname "$0")/.."
version=$(node -p 'require("./package.json").version')
app=out/mac/Switchboard.app
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos11" mac/Switchboard.swift -o "$tmp/$arch"
done
lipo -create "$tmp/arm64" "$tmp/x86_64" -output "$app/Contents/MacOS/Switchboard"
sed "s/__VERSION__/$version/g" mac/Info.plist > "$app/Contents/Info.plist"
codesign --force --sign - "$app"
echo "Built $app ($version)"
