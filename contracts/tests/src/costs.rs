//! The Fairground contract's own cost constants, read from its source so the
//! tests check the numbers the contract really uses (this crate does not
//! depend on the contract crate: see Cargo.toml).

/// `contracts/fairground/src/costs.rs`.
const COSTS_RS: &str = include_str!("../../fairground/src/costs.rs");

/// The value of `pub const <name>: <type> = <integer literal>;` in costs.rs.
/// Panics if there is no such constant or its value is not a literal: the
/// test is then out of date with the contract.
pub fn fairground_const(name: &str) -> u128 {
    let prefix = format!("pub const {name}: ");
    let line = COSTS_RS
        .lines()
        .find(|line| line.starts_with(&prefix))
        .unwrap_or_else(|| panic!("no constant {name} in costs.rs"));
    let value = line
        .split_once('=')
        .map(|(_, value)| value.trim().trim_end_matches(';').replace('_', ""))
        .unwrap_or_default();
    value
        .parse()
        .unwrap_or_else(|_| panic!("{name} is not an integer literal: {line}"))
}

/// `OUTLAYER_COMPUTE_DEPOSIT`: twice OutLayer's estimate for the sealer's
/// resource limits at the prices the contract was built for.
pub fn outlayer_compute_deposit() -> u128 {
    let instructions = fairground_const("SEALER_MAX_INSTRUCTIONS");
    let seconds = fairground_const("SEALER_MAX_EXECUTION_SECONDS");
    2 * (fairground_const("OUTLAYER_BASE_FEE")
        + instructions / 1_000_000 * fairground_const("OUTLAYER_PER_MILLION_INSTRUCTIONS_FEE")
        + seconds * 1_000 * fairground_const("OUTLAYER_PER_MS_FEE"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_contract_constants() {
        assert!(fairground_const("BID_BYTES_TEE") > fairground_const("BID_BYTES_COMMIT_REVEAL"));
        // 0.01401 NEAR, as DESIGN states.
        assert_eq!(outlayer_compute_deposit(), 14_010_000_000_000_000_000_000);
    }
}
