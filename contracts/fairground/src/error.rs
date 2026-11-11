//! Errors returned by public methods. A method that returns `Err` panics with
//! the error's message (`#[handle_result]`), so the call fails and its state
//! changes are rolled back. `ft_on_transfer` and the callbacks never return
//! errors: they log and carry on.

use core::fmt;

use near_sdk::{FunctionError, Gas};

#[derive(Debug, Clone, PartialEq, Eq, FunctionError)]
pub enum Error {
    /// A `new` argument breaks a configuration rule.
    InvalidConfig(&'static str),
    /// A sale parameter breaks its rule.
    InvalidParam {
        field: &'static str,
        rule: &'static str,
    },
    SaleExists,
    UnknownSale,
    QuoteTokenNotAllowed,
    /// The attached NEAR does not cover the cost.
    DepositTooLow {
        required: u128,
        attached: u128,
    },
    /// The call's gas does not cover the promises it must create.
    NotEnoughGas {
        required: Gas,
    },
    /// The sale is not in a state that allows the action.
    WrongPhase {
        action: &'static str,
        status: &'static str,
    },
    /// The action is allowed from this time (nanoseconds).
    TooEarly {
        action: &'static str,
        at: u64,
    },
    /// The action was allowed until this time (nanoseconds).
    TooLate {
        action: &'static str,
        at: u64,
    },
    NothingToRetry,
    NoBid,
    AlreadyRevealed,
    BadSalt,
    CommitmentMismatch,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfig(rule) => write!(f, "invalid config: {rule}"),
            Self::InvalidParam { field, rule } => write!(f, "invalid {field}: {rule}"),
            Self::SaleExists => f.write_str("a sale with this id already exists"),
            Self::UnknownSale => f.write_str("unknown sale"),
            Self::QuoteTokenNotAllowed => f.write_str("quote_token is not an allowed quote token"),
            Self::DepositTooLow { required, attached } => write!(
                f,
                "attached deposit {attached} yoctoNEAR is below the required {required} yoctoNEAR"
            ),
            Self::NotEnoughGas { required } => write!(
                f,
                "not enough gas: attach at least {} TGas",
                required.as_gas().div_ceil(Gas::from_tgas(1).as_gas())
            ),
            Self::WrongPhase { action, status } => write!(f, "cannot {action}: sale is {status}"),
            Self::TooEarly { action, at } => write!(f, "cannot {action} before {at} ns"),
            Self::TooLate { action, at } => write!(f, "cannot {action} after {at} ns"),
            Self::NothingToRetry => f.write_str("nothing to retry: no setup step has failed"),
            Self::NoBid => f.write_str("this account has no bid in this sale"),
            Self::AlreadyRevealed => f.write_str("this bid is already revealed"),
            Self::BadSalt => f.write_str("salt must be 32 hex characters"),
            Self::CommitmentMismatch => f.write_str("the reveal does not match the commitment"),
        }
    }
}
