//! Fairground on a local sandbox node (scripts/sandbox.ps1). Tests must run one
//! at a time (`--test-threads=1`): see the harness docs in src/lib.rs.

mod commit_reveal;
mod failures;
mod gas;
mod guards;
mod liquidity;
mod rejections;
mod tee;
