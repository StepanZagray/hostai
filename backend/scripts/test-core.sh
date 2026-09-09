#!/bin/sh
# A real subset of the Maven tests; does not verify Spring/HTTP integration.
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
jdk=${JAVA_HOME:-/usr/lib/jvm/java-26-openjdk}
out="$base/target/core-checks"
mkdir -p "$out"
"$jdk/bin/javac" --release 26 -d "$out" \
    "$base/src/main/java/com/hostai/backend/InferenceRegistry.java" \
    "$base/src/main/java/com/hostai/backend/LocalOllamaEndpoint.java" \
    "$base/src/test/java/com/hostai/backend/CoreChecks.java"
"$jdk/bin/java" -cp "$out" com.hostai.backend.CoreChecks
