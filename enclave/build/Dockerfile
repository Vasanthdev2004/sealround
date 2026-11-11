# The image that builds Fairground's enclave job (the OutLayer job).
#
# The job's wasm sha256 is pinned on chain (the contract's sealer source, the
# OutLayer project version, the keystore's WasmHash condition), so anyone must
# be able to rebuild the exact same bytes. This image fixes the operating
# system, the Rust toolchain and the paths; build.sh, run inside it with the
# repository mounted read-only at /src, fixes the command, the environment and
# the flags. scripts/build-enclave.ps1 drives both. To build by hand, see
# build.sh.
#
# Base: the official rust:1.97.1-trixie image, pinned by digest because a tag
# can be moved and a digest cannot. This is the linux/amd64 manifest of index
# sha256:b1b3c9c0d921d7fa0a6d1f9ec7e4eab87f8c8ec97644c3d791450f131dec813f, which
# the tag named on 9 Nov 2026 (`docker buildx imagetools inspect
# rust:1.97.1-trixie`; image created 2026-08-05, docker-rust revision
# 40acf7919e2e27dc706918e42758a6f1c21e806b). Its rustup toolchain 1.97.1 is the
# compiler that enclave/rust-toolchain.toml pins. amd64 on every host: other
# architectures run it emulated, so the compiler is the same binary everywhere.
#
# No `# syntax=` line: BuildKit's built-in Dockerfile frontend is used, so the
# image build fetches nothing but the base image and the target below.
FROM rust:1.97.1-trixie@sha256:4277ce860337f6cfa1b679891bbf689a447f4b3f4f55701742614ad31321cee7

# The job's target, installed into the image so the build itself never fetches
# a toolchain component. rustup checks the download against the sha256 in the
# 1.97.1 release manifest, so it is the same standard library everywhere.
RUN rustup target add --toolchain 1.97.1 wasm32-wasip1
