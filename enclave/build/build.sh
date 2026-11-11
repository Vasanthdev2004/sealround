#!/bin/sh
# Builds Fairground's enclave job (crate fairground-sealer-job, binary
# fairground-sealer) for wasm32-wasip1, so that every build of the same sources
# gives the same bytes. Runs inside the image from enclave/build/Dockerfile,
# with:
#
#   /src  the repository, mounted read-only
#   /out  an empty, writable directory
#
# and writes /out/fairground_sealer.wasm, /out/fairground_sealer.wasm.sha256
# (sha256sum format: lowercase hex, the value OutLayer and the contract pin)
# and /out/build-info.json.
#
# scripts/build-enclave.ps1 runs this. By hand, from the repository root, on any
# machine with Docker:
#
#   docker build --platform linux/amd64 -t fairground-enclave-build:1.97.1 enclave/build
#   mkdir out
#   docker run --rm --platform linux/amd64 -v "$PWD:/src:ro" -v "$PWD/out:/out" \
#       fairground-enclave-build:1.97.1 sh /src/enclave/build/build.sh
#   cat out/fairground_sealer.wasm.sha256
#
# What could differ between two builds, and how it is fixed:
# - the compiler: the image's rustup toolchain 1.97.1, which
#   enclave/rust-toolchain.toml selects (rustup reads it from the current
#   directory, hence the cd below);
# - the dependencies: enclave/Cargo.lock with --locked, and cargo checks every
#   downloaded crate against the checksum recorded there;
# - the environment: cargo runs under `env -i` with only the variables below,
#   so nothing set in the image or by `docker run -e` reaches the build;
# - the paths: fixed inside the container, then rewritten by
#   --remap-path-prefix. Panic-location strings in the wasm hold source paths;
#   with the remap they read /fairground/..., /cargo/... and /target/...;
# - the cache: none. The target and registry directories live in the
#   container and are thrown away with it, so every build starts from nothing.
# Nothing in the build reads the clock, and the profile (enclave/Cargo.toml)
# has codegen-units = 1 and no incremental compilation.
set -eu

SRC=/src
OUT=/out
TARGET_DIR=/tmp/fairground-target
# The image's CARGO_HOME; the crates this build downloads go under it.
CARGO_DIR=/usr/local/cargo
WASM_TARGET=wasm32-wasip1
PACKAGE=fairground-sealer-job
BIN=fairground-sealer
ARTIFACT=fairground_sealer.wasm
RUSTFLAGS="--remap-path-prefix=$SRC=/fairground --remap-path-prefix=$CARGO_DIR=/cargo --remap-path-prefix=$TARGET_DIR=/target"

fail() {
    echo "build.sh: $*" >&2
    exit 1
}

[ -f "$SRC/enclave/Cargo.lock" ] || fail "$SRC does not hold the repository (no enclave/Cargo.lock)"
[ -d "$OUT" ] || fail "$OUT is not mounted"
[ -z "$(ls -A "$OUT")" ] || fail "$OUT is not empty"
[ ! -e "$TARGET_DIR" ] || fail "$TARGET_DIR exists: this build would not start from nothing"

# Only these variables reach rustup, cargo and rustc.
clean_env() {
    env -i \
        PATH="$CARGO_DIR/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
        HOME=/tmp \
        LC_ALL=C.UTF-8 \
        TZ=UTC \
        RUSTUP_HOME=/usr/local/rustup \
        CARGO_HOME="$CARGO_DIR" \
        CARGO_TARGET_DIR="$TARGET_DIR" \
        CARGO_INCREMENTAL=0 \
        CARGO_TERM_COLOR=never \
        RUSTFLAGS="$RUSTFLAGS" \
        "$@"
}

cd "$SRC/enclave"

echo "==> toolchain and environment"
# Into files first: in a pipeline, `set -e` would only see the last command.
clean_env rustup show active-toolchain > /tmp/active-toolchain.txt
clean_env rustc -vV > /tmp/rustc-vV.txt
clean_env cargo -V > /tmp/cargo-V.txt
clean_env env > /tmp/build-env.txt
cat /tmp/active-toolchain.txt /tmp/rustc-vV.txt /tmp/cargo-V.txt

echo "==> cargo build --locked --release --target $WASM_TARGET -p $PACKAGE"
echo "    RUSTFLAGS=$RUSTFLAGS"
clean_env cargo build --locked --release --target "$WASM_TARGET" -p "$PACKAGE"

cp "$TARGET_DIR/$WASM_TARGET/release/$BIN.wasm" "$OUT/$ARTIFACT"

echo "==> check the module and write build-info.json"
# -I: ignore PYTHON* variables and the user's site packages.
python3 -I "$SRC/enclave/build/build_info.py" \
    --src "$SRC" \
    --wasm "$OUT/$ARTIFACT" \
    --dep-info "$TARGET_DIR/$WASM_TARGET/release/$BIN.d" \
    --rustc-vv /tmp/rustc-vV.txt \
    --cargo-v /tmp/cargo-V.txt \
    --active-toolchain /tmp/active-toolchain.txt \
    --build-env /tmp/build-env.txt \
    --command "cargo build --locked --release --target $WASM_TARGET -p $PACKAGE" \
    --forbid "$SRC/crates/" --forbid "$SRC/enclave/" --forbid "$CARGO_DIR/" --forbid "$TARGET_DIR/" \
    --out "$OUT/build-info.json" ||
    { rm -f "$OUT/$ARTIFACT" "$OUT/build-info.json"; fail "the module failed its checks (see above); nothing was kept"; }

(cd "$OUT" && sha256sum "$ARTIFACT" > "$ARTIFACT.sha256")
echo "==> $(cat "$OUT/$ARTIFACT.sha256")"
