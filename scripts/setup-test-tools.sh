#!/usr/bin/env bash
# Fetches and builds the third-party tools used to verify this implementation:
# - The qifs corpus: QIF inputs plus encoded outputs from other QPACK
#   implementations (https://github.com/qpackers/qifs)
# - ls-qpack's interop-encode/interop-decode CLI tools, used as an
#   independent reference implementation (https://github.com/litespeedtech/ls-qpack)
# Everything is placed in test/tools/, which is gitignored.
set -euo pipefail
cd "$(dirname "$0")/.."

QIFS_REPO=https://github.com/qpackers/qifs.git
QIFS_COMMIT=da52cd936b3e34dac7ac12aa8066fc57676af106
LSQPACK_REPO=https://github.com/litespeedtech/ls-qpack.git
LSQPACK_TAG=v2.6.5

TOOLS=test/tools
PINS="$QIFS_COMMIT $LSQPACK_TAG v1"

if [ -f "$TOOLS/.pins" ] && [ "$(cat "$TOOLS/.pins")" = "$PINS" ]; then
    echo "Test tools already set up (test/tools/.pins matches) - skipping."
    exit 0
fi

rm -rf "$TOOLS"
mkdir -p "$TOOLS/bin"

echo "Fetching qifs corpus at $QIFS_COMMIT..."
git init -q "$TOOLS/qifs"
git -C "$TOOLS/qifs" fetch -q --depth 1 "$QIFS_REPO" "$QIFS_COMMIT"
git -C "$TOOLS/qifs" checkout -q FETCH_HEAD

echo "Fetching ls-qpack at $LSQPACK_TAG..."
git clone -q --depth 1 --branch "$LSQPACK_TAG" --recurse-submodules \
    --shallow-submodules "$LSQPACK_REPO" "$TOOLS/ls-qpack"

echo "Building ls-qpack interop tools..."
LSQ="$TOOLS/ls-qpack"
cc -O2 -I"$LSQ" -I"$LSQ/deps/xxhash" \
    "$LSQ/lsqpack.c" "$LSQ/deps/xxhash/xxhash.c" "$LSQ/bin/interop-encode.c" \
    -lm -o "$TOOLS/bin/interop-encode"
cc -O2 -I"$LSQ" -I"$LSQ/test" -I"$LSQ/deps/xxhash" \
    "$LSQ/lsqpack.c" "$LSQ/deps/xxhash/xxhash.c" "$LSQ/bin/interop-decode.c" \
    -lm -o "$TOOLS/bin/interop-decode"

"$TOOLS/bin/interop-encode" -h > /dev/null 2>&1 || { echo "interop-encode failed to run"; exit 1; }
"$TOOLS/bin/interop-decode" -h > /dev/null 2>&1 || { echo "interop-decode failed to run"; exit 1; }

echo "$PINS" > "$TOOLS/.pins"
echo "Test tools ready in $TOOLS/."
