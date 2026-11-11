"""Checks the enclave job's wasm and writes build-info.json.

build.sh runs this inside the build image right after cargo, with the image's
python3 and the standard library only.

The checks fail the build instead of shipping a module that OutLayer's worker
would refuse, or one that leaks a build path:

- every import is a `wasi_snapshot_preview1` function that wasmtime-wasi 28
  provides. The worker links a P1 module with `preview1::add_to_linker_async`
  (worker/src/executor/wasi_p1.rs), so any other import fails instantiation;
- the module exports `memory` and `_start: () -> ()`, which the worker calls;
- none of the container's real paths survived `--remap-path-prefix`.

build-info.json records what went into the build: the base image, the
toolchain, the command and environment, the Cargo.lock hash and the sha256 of
every repository file the build read. It holds no time and nothing about the
machine, so two builds of the same sources write the same file (apart from the
git fields, which the caller passes in).
"""

import argparse
import hashlib
import json
import os
import platform
import re
import sys
from pathlib import Path

# Every function in wasmtime-wasi 28.0.1's witx/preview1/wasi_snapshot_preview1.witx,
# which is what `preview1::add_to_linker_async` defines (46 functions).
WASI_P1_MODULE = "wasi_snapshot_preview1"
WASI_P1_FUNCTIONS = frozenset(
    """
    args_get args_sizes_get environ_get environ_sizes_get clock_res_get
    clock_time_get fd_advise fd_allocate fd_close fd_datasync fd_fdstat_get
    fd_fdstat_set_flags fd_fdstat_set_rights fd_filestat_get fd_filestat_set_size
    fd_filestat_set_times fd_pread fd_prestat_get fd_prestat_dir_name fd_pwrite
    fd_read fd_readdir fd_renumber fd_seek fd_sync fd_tell fd_write
    path_create_directory path_filestat_get path_filestat_set_times path_link
    path_open path_readlink path_remove_directory path_rename path_symlink
    path_unlink_file poll_oneoff proc_exit proc_raise sched_yield random_get
    sock_accept sock_recv sock_send sock_shutdown
    """.split()
)

# Repository files the build reads besides the Rust sources listed in cargo's
# dep-info: the manifests (the root one too, because crates/* inherit their
# edition and dependencies from it), the lock file, the toolchain pin, cargo's
# configuration and this build's own definition. Recorded when present.
BUILD_FILES = (
    "Cargo.toml",
    ".cargo/config.toml",
    "crates/clearing/Cargo.toml",
    "crates/sealer/Cargo.toml",
    "enclave/Cargo.toml",
    "enclave/Cargo.lock",
    "enclave/rust-toolchain.toml",
    "enclave/job/Cargo.toml",
    "enclave/tools/harness/Cargo.toml",
    "enclave/tools/runner/Cargo.toml",
    "enclave/build/Dockerfile",
    "enclave/build/build.sh",
    "enclave/build/build_info.py",
)

# Section ids and import/export kinds from the WebAssembly binary format.
SECTION_CUSTOM, SECTION_TYPE, SECTION_IMPORT, SECTION_FUNCTION, SECTION_EXPORT = 0, 1, 2, 3, 7
KIND_FUNC, KIND_TABLE, KIND_MEMORY, KIND_GLOBAL, KIND_TAG = 0, 1, 2, 3, 4
KIND_NAMES = {KIND_FUNC: "func", KIND_TABLE: "table", KIND_MEMORY: "memory", KIND_GLOBAL: "global", KIND_TAG: "tag"}
# i32 i64 f32 f64 v128 funcref externref: every value type a Rust module uses.
SIMPLE_VALTYPES = frozenset((0x7F, 0x7E, 0x7D, 0x7C, 0x7B, 0x70, 0x6F))


class Reader:
    """Reads one section of a module. Raises ValueError on anything malformed."""

    def __init__(self, data: bytes, pos: int, end: int):
        self.data, self.pos, self.end = data, pos, end

    def byte(self) -> int:
        if self.pos >= self.end:
            raise ValueError("unexpected end of section")
        value = self.data[self.pos]
        self.pos += 1
        return value

    def uleb(self) -> int:
        result = shift = 0
        while True:
            b = self.byte()
            result |= (b & 0x7F) << shift
            if b < 0x80:
                return result
            shift += 7
            if shift > 63:
                raise ValueError("LEB128 value too long")

    def take(self, n: int) -> bytes:
        if self.pos + n > self.end:
            raise ValueError("unexpected end of section")
        out = self.data[self.pos : self.pos + n]
        self.pos += n
        return out

    def name(self) -> str:
        return self.take(self.uleb()).decode("utf-8")

    def valtype(self) -> int:
        t = self.byte()
        if t not in SIMPLE_VALTYPES:
            raise ValueError(f"unsupported value type 0x{t:02x}")
        return t

    def limits(self) -> None:
        flags = self.byte()
        self.uleb()
        if flags & 1:
            self.uleb()


def parse_module(wasm: bytes) -> dict:
    """The parts of a module the checks need: types, imports, exports, custom sections."""
    if wasm[:8] != b"\0asm\x01\0\0\0":
        raise ValueError("not a WebAssembly 1.0 module")
    types, func_type_indices, imports, exports, custom = [], [], [], [], []
    top = Reader(wasm, 8, len(wasm))
    while top.pos < top.end:
        section_id = top.byte()
        size = top.uleb()
        r = Reader(wasm, top.pos, top.pos + size)
        if r.end > len(wasm):
            raise ValueError("section runs past the end of the module")
        if section_id == SECTION_CUSTOM:
            name = r.name()
            custom.append((name, r.end - r.pos))
        elif section_id == SECTION_TYPE:
            for _ in range(r.uleb()):
                if r.byte() != 0x60:
                    raise ValueError("type section holds a non-function type")
                params = tuple(r.valtype() for _ in range(r.uleb()))
                results = tuple(r.valtype() for _ in range(r.uleb()))
                types.append((params, results))
        elif section_id == SECTION_IMPORT:
            for _ in range(r.uleb()):
                module, field, kind = r.name(), r.name(), r.byte()
                if kind == KIND_FUNC:
                    func_type_indices.append(r.uleb())
                elif kind == KIND_TABLE:
                    r.valtype()
                    r.limits()
                elif kind == KIND_MEMORY:
                    r.limits()
                elif kind == KIND_GLOBAL:
                    r.valtype()
                    r.byte()
                elif kind == KIND_TAG:
                    r.byte()
                    r.uleb()
                else:
                    raise ValueError(f"unknown import kind {kind}")
                imports.append((module, field, kind))
        elif section_id == SECTION_FUNCTION:
            func_type_indices.extend(r.uleb() for _ in range(r.uleb()))
        elif section_id == SECTION_EXPORT:
            for _ in range(r.uleb()):
                exports.append((r.name(), r.byte(), r.uleb()))
        top.pos = r.end
    return {
        "types": types,
        "func_type_indices": func_type_indices,
        "imports": imports,
        "exports": exports,
        "custom": custom,
    }


def check_module(module: dict, wasm: bytes, forbidden: list[str]) -> list[str]:
    """Every reason the worker would refuse the module, or it leaks a path."""
    problems = []
    for mod, field, kind in module["imports"]:
        if mod != WASI_P1_MODULE or kind != KIND_FUNC or field not in WASI_P1_FUNCTIONS:
            problems.append(f"import {mod}.{field} ({KIND_NAMES.get(kind, kind)}) is not a WASI P1 function wasmtime 28 provides")
    exports = {name: (kind, index) for name, kind, index in module["exports"]}
    start = exports.get("_start")
    if start is None or start[0] != KIND_FUNC:
        problems.append("no exported function _start (the worker calls it)")
    else:
        indices = module["func_type_indices"]
        if start[1] >= len(indices) or module["types"][indices[start[1]]] != ((), ()):
            problems.append("_start is not a function () -> ()")
    if exports.get("memory", (None,))[0] != KIND_MEMORY:
        problems.append("no exported memory (WASI needs it)")
    for prefix in forbidden:
        count = wasm.count(prefix.encode())
        if count:
            problems.append(f"{count} occurrence(s) of the build path {prefix} survived --remap-path-prefix")
    return problems


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def dep_info_files(dep_info: Path, src: str) -> set[str]:
    """Repository files the compiler read, from cargo's dep-info file for the binary.

    Make syntax: `<output>: <input> <input> ...`, with spaces in names escaped
    as `\\ `. Inputs outside the repository (the crates.io sources) are pinned
    by Cargo.lock's checksums instead.
    """
    files = set()
    for line in dep_info.read_text(encoding="utf-8").splitlines():
        _, sep, deps = line.partition(": ")
        if not sep:
            continue
        for dep in re.split(r"(?<!\\) ", deps.strip()):
            dep = dep.replace("\\ ", " ")
            if dep.startswith(src + "/"):
                files.add(dep[len(src) + 1 :])
    if not files:
        raise ValueError(f"{dep_info} names no file under {src}")
    return files


def key_values(path: Path) -> dict:
    """`key: value` lines, as `rustc -vV` prints them."""
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.partition(": ")
        if sep:
            out[key.strip()] = value.strip()
    return out


def base_image(dockerfile: Path) -> str:
    for line in dockerfile.read_text(encoding="utf-8").splitlines():
        if line.startswith("FROM "):
            return line.split()[1]
    raise ValueError(f"no FROM line in {dockerfile}")


def git_facts() -> dict | None:
    """What the caller found with git on the host (the container has no usable git)."""
    head = os.environ.get("FAIRGROUND_GIT_HEAD", "")
    clean = os.environ.get("FAIRGROUND_GIT_INPUTS_CLEAN", "")
    if not head:
        return None
    inputs_clean = clean == "true"
    return {
        # Set only when every build input is committed and unmodified: only
        # then does the commit identify the sources.
        "commit": head if inputs_clean else None,
        "head": head,
        "inputs_clean": inputs_clean,
    }


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--src", required=True)
    p.add_argument("--wasm", required=True, type=Path)
    p.add_argument("--dep-info", required=True, type=Path)
    p.add_argument("--rustc-vv", required=True, type=Path)
    p.add_argument("--cargo-v", required=True, type=Path)
    p.add_argument("--active-toolchain", required=True, type=Path)
    p.add_argument("--build-env", required=True, type=Path)
    p.add_argument("--command", required=True)
    p.add_argument("--forbid", action="append", default=[])
    p.add_argument("--out", required=True, type=Path)
    a = p.parse_args()

    wasm = a.wasm.read_bytes()
    module = parse_module(wasm)
    problems = check_module(module, wasm, a.forbid)

    imports = [f"{m}.{f}" for m, f, _ in module["imports"]]
    exports = [f"{name} ({KIND_NAMES.get(kind, kind)})" for name, kind, _ in module["exports"]]
    print("imports:", ", ".join(imports) or "none")
    print("exports:", ", ".join(exports) or "none")
    print("custom sections:", ", ".join(f"{n} ({s} bytes)" for n, s in module["custom"]) or "none")
    for prefix in ("/fairground/", "/cargo/", "/target/"):
        print(f"remapped paths under {prefix}: {wasm.count(prefix.encode())}")
    if problems:
        for problem in problems:
            print(f"error: {problem}", file=sys.stderr)
        return 1

    src = Path(a.src)
    files = dep_info_files(a.dep_info, a.src) | {f for f in BUILD_FILES if (src / f).is_file()}
    file_hashes = {f: sha256_file(src / f) for f in sorted(files)}
    # One value for the whole set, in `sha256sum` format so it can be recomputed:
    # (cd <repo> && sha256sum <files in this order>) | sha256sum
    listing = "".join(f"{h}  {f}\n" for f, h in file_hashes.items())

    rustc = key_values(a.rustc_vv)
    env = dict(line.split("=", 1) for line in a.build_env.read_text(encoding="utf-8").splitlines() if "=" in line)

    info = {
        "artifact": {
            "file": a.wasm.name,
            "bytes": len(wasm),
            # OutLayer's WasmUrl hash and project version_key: sha256 of these bytes.
            "sha256": hashlib.sha256(wasm).hexdigest(),
        },
        "job": {
            "package": "fairground-sealer-job",
            "binary": "fairground-sealer",
            "target": "wasm32-wasip1",
            "profile": "release (enclave/Cargo.toml)",
        },
        "build": {
            "image": base_image(src / "enclave/build/Dockerfile"),
            "dockerfile": "enclave/build/Dockerfile",
            # x86_64 on every host: the image is the amd64 one (emulated elsewhere).
            "machine": platform.machine(),
            "cwd": str(src / "enclave"),
            "command": a.command,
            # Everything cargo and rustc saw (build.sh runs them under env -i).
            "env": env,
        },
        "toolchain": {
            "active": a.active_toolchain.read_text(encoding="utf-8").strip(),
            "rustc": rustc.get("release"),
            "rustc_commit_hash": rustc.get("commit-hash"),
            "rustc_commit_date": rustc.get("commit-date"),
            "rustc_host": rustc.get("host"),
            "llvm": rustc.get("LLVM version"),
            "cargo": a.cargo_v.read_text(encoding="utf-8").strip(),
        },
        "inputs": {
            "cargo_lock_sha256": file_hashes["enclave/Cargo.lock"],
            "files_sha256": hashlib.sha256(listing.encode()).hexdigest(),
            "files": file_hashes,
        },
        "git": git_facts(),
        "module": {
            "imports": imports,
            "exports": [name for name, _, _ in module["exports"]],
            "custom_sections": {name: size for name, size in module["custom"]},
        },
    }
    a.out.write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
