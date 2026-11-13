//! Sale parameters, their validation, the stored sale and its state machine.

use fairground_clearing::{MAX_DECIMALS, SaleParams, one_token};
use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, near};

use crate::costs::MAX_BIDS_PER_SALE;
use crate::liquidity::{Liquidity, LiquidityParams};
use crate::{Config, Error};

const MINUTE: u64 = 60 * 1_000_000_000;
const DAY: u64 = 24 * 60 * MINUTE;

/// Longest sale id; the token account is `<sale_id>.<contract>`.
pub const MAX_SALE_ID_LEN: usize = 32;
pub const MAX_TOKEN_NAME_LEN: usize = 64;
pub const MAX_TOKEN_SYMBOL_LEN: usize = 16;
/// Icon data URL limit (it is stored in the token's metadata too).
pub const MAX_ICON_LEN: usize = 2048;
pub const MAX_DESCRIPTION_LEN: usize = 280;
pub const MAX_WEBSITE_LEN: usize = 200;
pub const MAX_BID_WINDOW_NS: u64 = 30 * DAY;
pub const MIN_SETTLE_TIMEOUT_NS: u64 = 10 * MINUTE;
/// Upper bound so a creator cannot freeze bidders' funds for years.
pub const MAX_SETTLE_TIMEOUT_NS: u64 = 7 * DAY;
pub const DEFAULT_REVEAL_WINDOW_NS: u64 = 10 * MINUTE;
pub const MIN_REVEAL_WINDOW_NS: u64 = MINUTE;
pub const MAX_REVEAL_WINDOW_NS: u64 = 7 * DAY;
/// Smallest `min_deposit`: 1 USDC (6 decimals). An invalid bid pays 1 % of its
/// deposit, so this floor is what makes filling a sale's bid slots with junk
/// bids cost something (DESIGN "Bid slots and invalid bids").
pub const MIN_DEPOSIT_FLOOR: u128 = 1_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RevealMode {
    /// Bids are sealed to the enclave's key; OutLayer clears the sale.
    Tee,
    /// Bids are hash commitments, revealed after close; the contract clears.
    CommitReveal,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum UnsoldRule {
    /// Unsold sale tokens are burned with `token.burn`.
    #[default]
    Burn,
}

/// `create_sale` / `get_create_cost` argument. Unknown fields are refused so a
/// misspelt optional field cannot silently fall back to its default.
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateSaleParams {
    pub sale_id: String,
    pub token_name: String,
    pub token_symbol: String,
    pub decimals: u8,
    #[serde(default)]
    pub icon: Option<String>,
    pub total_supply: U128,
    pub sale_supply: U128,
    pub floor_price: U128,
    #[serde(default)]
    pub max_price: Option<U128>,
    pub min_raise: U128,
    pub bid_start: U64,
    pub bid_end: U64,
    pub min_deposit: U128,
    pub max_deposit_per_account: U128,
    pub max_bids: u32,
    pub reveal_mode: RevealMode,
    /// Commit-reveal only; defaults to 10 minutes.
    #[serde(default)]
    pub reveal_window: Option<U64>,
    pub settle_timeout: U64,
    pub quote_token: AccountId,
    #[serde(default)]
    pub unsold_rule: Option<UnsoldRule>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
    /// Launch liquidity: a pool seeded at the clearing price after the sale.
    #[serde(default)]
    pub liquidity: Option<LiquidityParams>,
}

/// Economic terms, fixed at creation.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SaleTerms {
    pub total_supply: u128,
    pub sale_supply: u128,
    pub decimals: u8,
    pub floor_price: u128,
    pub max_price: Option<u128>,
    pub min_raise: u128,
    pub bid_start: u64,
    pub bid_end: u64,
    pub min_deposit: u128,
    pub max_deposit: u128,
    pub max_bids: u32,
}

impl SaleTerms {
    pub(crate) fn clearing_params(&self) -> SaleParams {
        SaleParams {
            sale_supply: self.sale_supply,
            floor_price: self.floor_price,
            min_raise: self.min_raise,
            decimals: self.decimals,
            max_price: self.max_price,
        }
    }
}

/// Display data and token metadata, fixed at creation.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SaleMeta {
    pub token_name: String,
    pub token_symbol: String,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub website: Option<String>,
}

impl SaleMeta {
    /// Bytes of token metadata strings, which the token stores too.
    pub(crate) fn token_metadata_len(&self) -> usize {
        self.token_name.len() + self.token_symbol.len() + self.icon.as_ref().map_or(0, String::len)
    }

    /// Bytes of every variable-length string.
    pub(crate) fn variable_len(&self) -> usize {
        self.token_metadata_len()
            + self.description.as_ref().map_or(0, String::len)
            + self.website.as_ref().map_or(0, String::len)
    }
}

/// Stored phase. The view status refines `Bidding` by time.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Setup,
    Bidding,
    Clearing,
    Closed,
    Revealing,
    Settled,
    Failed,
}

/// Status as shown in views.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Setup,
    Upcoming,
    Open,
    AwaitingClose,
    Clearing,
    Closed,
    Revealing,
    Settled,
    Failed,
}

impl Status {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Setup => "setup",
            Self::Upcoming => "upcoming",
            Self::Open => "open",
            Self::AwaitingClose => "awaiting_close",
            Self::Clearing => "clearing",
            Self::Closed => "closed",
            Self::Revealing => "revealing",
            Self::Settled => "settled",
            Self::Failed => "failed",
        }
    }
}

/// A setup step (token deploy, sealer key, quote-token registration).
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepState {
    Pending,
    Done,
    Failed,
}

/// Why a sale failed.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailReason {
    /// Closed with no bids.
    NoBids,
    NoValidBids,
    BelowMinRaise,
    /// Valid bids, but no token was sold.
    NothingSold,
    /// The enclave's result failed a contract check.
    ChecksFailed,
    /// `trigger_refund_mode` after the settle timeout.
    RefundMode,
}

impl FailReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NoBids => "no_bids",
            Self::NoValidBids => "no_valid_bids",
            Self::BelowMinRaise => "below_min_raise",
            Self::NothingSold => "nothing_sold",
            Self::ChecksFailed => "checks_failed",
            Self::RefundMode => "refund_mode",
        }
    }
}

/// Clearing outcome and bookkeeping. Zero until the sale is final.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SaleResult {
    pub fail_reason: Option<FailReason>,
    pub clearing_price: u128,
    pub total_sold: u128,
    pub total_raised: u128,
    pub n_valid: u32,
    pub n_invalid: u32,
    /// Bids that receive tokens; each needs a token registration.
    pub n_winners: u32,
    /// The first failed checks, by name (at most `MAX_STORED_CHECKS`).
    pub failed_checks: Vec<String>,
    pub failed_checks_total: u32,
    /// sha256 of the last sealer output, exactly as received (= OutLayer's
    /// attestation `output_hash`).
    pub result_sha256: Option<[u8; 32]>,
    /// sha256 of the last clearing input (= OutLayer's attestation `input_hash`).
    pub input_sha256: Option<[u8; 32]>,
    pub clear_requests: u32,
    /// Block height of the call that sent the latest clearing request to
    /// OutLayer (TEE mode), to find that transaction and its attestation.
    pub clear_request_block: Option<u64>,
    /// Clearing attempts that ended in Closed.
    pub clear_attempts: u32,
    /// The 1 % penalties of the invalid bids, locked in this contract for
    /// good. Zero unless the enclave's checked result or `clear_onchain`
    /// decided the sale.
    pub total_penalties: u128,
}

/// What the creator payouts have paid so far (USDC, sale tokens, sale tokens
/// burned, NEAR). Each amount is added before its promise and taken off again
/// if the promise fails; `claim_proceeds` pays what is owed minus these.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Proceeds {
    pub raise_paid: u128,
    pub allocation_paid: u128,
    pub burned: u128,
    pub reserve_returned: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sale {
    /// Index in `sale_ids`; keys every per-sale collection.
    pub num: u32,
    pub creator: AccountId,
    /// The sale token, `<sale_id>.<contract>`.
    pub token: AccountId,
    pub quote_token: AccountId,
    pub created_at: u64,
    pub terms: SaleTerms,
    pub reveal_mode: RevealMode,
    pub reveal_window: u64,
    pub settle_timeout: u64,
    pub sealer_code_hash: String,
    /// NEAR sent with the token deploy (it stays with the token account).
    pub token_deploy_balance: u128,
    pub token_state: StepState,
    /// `Done` from the start in commit-reveal mode.
    pub key_state: StepState,
    pub sealer_pubkey: Option<[u8; 32]>,
    /// Block height of the call that sent the sealer key request (TEE mode;
    /// the latest one after a `retry_setup`).
    pub key_request_block: Option<u64>,
    pub phase: Phase,
    pub closed_at: Option<u64>,
    pub bid_count: u32,
    pub total_deposits: u128,
    /// Running bid-set hash `h_n` (see DESIGN "Bid-set hash").
    pub bid_set_state: [u8; 32],
    pub result: SaleResult,
    pub proceeds: Proceeds,
    pub liquidity: Option<Liquidity>,
}

impl Sale {
    pub fn status(&self, now: u64) -> Status {
        match self.phase {
            Phase::Setup => Status::Setup,
            Phase::Bidding if now < self.terms.bid_start => Status::Upcoming,
            Phase::Bidding if now < self.terms.bid_end => Status::Open,
            Phase::Bidding => Status::AwaitingClose,
            Phase::Clearing => Status::Clearing,
            Phase::Closed => Status::Closed,
            Phase::Revealing => Status::Revealing,
            Phase::Settled => Status::Settled,
            Phase::Failed => Status::Failed,
        }
    }

    pub fn is_open(&self, now: u64) -> bool {
        self.status(now) == Status::Open
    }

    pub fn is_final(&self) -> bool {
        matches!(self.phase, Phase::Settled | Phase::Failed)
    }

    /// End of the reveal window (commit-reveal, once closed).
    pub fn reveal_end(&self) -> Option<u64> {
        match self.reveal_mode {
            RevealMode::CommitReveal => self
                .closed_at
                .map(|closed| closed.saturating_add(self.reveal_window)),
            RevealMode::Tee => None,
        }
    }

    /// When `trigger_refund_mode` becomes possible, or `None` once final.
    /// Counted from the close (or the end of the reveal window), else from `bid_end`.
    pub fn refund_mode_at(&self) -> Option<u64> {
        let reference = match self.phase {
            Phase::Settled | Phase::Failed => return None,
            Phase::Revealing => self.reveal_end()?,
            Phase::Setup | Phase::Bidding => self.terms.bid_end,
            Phase::Clearing | Phase::Closed => self.closed_at.unwrap_or(self.terms.bid_end),
        };
        Some(reference.saturating_add(self.settle_timeout))
    }

    /// Setup is complete: the token exists and, in TEE mode, so does the key.
    pub fn setup_complete(&self) -> bool {
        self.token_state == StepState::Done && self.key_state == StepState::Done
    }

    /// Sale tokens `claim_proceeds` burns in all: the sale supply buyers did
    /// not get, plus the launch pool reserve the pool does not take. Zero
    /// while the token is not deployed: there is nothing to burn then.
    pub fn unsold(&self) -> u128 {
        if self.token_state != StepState::Done {
            return 0;
        }
        let sale_part = match self.phase {
            Phase::Settled => self.terms.sale_supply - self.result.total_sold,
            _ => self.terms.sale_supply,
        };
        let pool_part = self.liquidity.as_ref().map_or(0, |liquidity| {
            liquidity.pool_tokens - liquidity.tokens_kept()
        });
        sale_part + pool_part
    }

    /// Sale tokens set aside for the launch pool.
    pub fn pool_reserve(&self) -> u128 {
        self.liquidity
            .as_ref()
            .map_or(0, |liquidity| liquidity.pool_tokens)
    }

    /// The creator's own sale tokens.
    pub fn creator_allocation(&self) -> u128 {
        self.terms.total_supply - self.terms.sale_supply - self.pool_reserve()
    }

    /// USDC the creator is owed in all: the raise, less what the launch pool
    /// takes. Zero unless settled.
    pub fn creator_raise(&self) -> u128 {
        if self.phase != Phase::Settled {
            return 0;
        }
        let kept = self.liquidity.as_ref().map_or(0, Liquidity::usdc_kept);
        self.result.total_raised.saturating_sub(kept)
    }

    /// Whether sale tokens may leave the contract (bidders' tokens and the
    /// creator allocation): always, except while the launch pool is seeded.
    pub fn tokens_unlocked(&self) -> bool {
        self.liquidity
            .as_ref()
            .is_none_or(|liquidity| !liquidity.locks_tokens())
    }
}

/// Validated `create_sale` input.
pub(crate) struct NewSale {
    pub sale_id: String,
    pub token: AccountId,
    pub terms: SaleTerms,
    pub meta: SaleMeta,
    pub reveal_mode: RevealMode,
    pub reveal_window: u64,
    pub settle_timeout: u64,
    pub quote_token: AccountId,
    pub liquidity: Option<Liquidity>,
}

fn invalid(field: &'static str, rule: &'static str) -> Error {
    Error::InvalidParam { field, rule }
}

impl CreateSaleParams {
    /// Checks every rule in DESIGN "Sale parameters" (plus the token's own
    /// metadata rules, so the token deploy cannot fail on them).
    pub(crate) fn validate(
        self,
        now: u64,
        contract: &AccountId,
        config: &Config,
    ) -> Result<NewSale, Error> {
        if !valid_sale_id(&self.sale_id) {
            return Err(invalid(
                "sale_id",
                "must match ^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$",
            ));
        }
        let token: AccountId = format!("{}.{contract}", self.sale_id)
            .parse()
            .map_err(|_| {
                invalid(
                    "sale_id",
                    "<sale_id>.<contract> must be a valid account id (no repeated '-' or '_', at most 64 characters)",
                )
            })?;

        let name = self.token_name.trim();
        if name.is_empty() || self.token_name.len() > MAX_TOKEN_NAME_LEN {
            return Err(invalid("token_name", "must be 1-64 bytes and not blank"));
        }
        let symbol = self.token_symbol.trim();
        if symbol.is_empty() || self.token_symbol.len() > MAX_TOKEN_SYMBOL_LEN {
            return Err(invalid("token_symbol", "must be 1-16 bytes and not blank"));
        }
        if self.decimals > MAX_DECIMALS {
            return Err(invalid("decimals", "must be at most 24"));
        }
        if let Some(icon) = &self.icon
            && (icon.len() > MAX_ICON_LEN || !icon.starts_with("data:"))
        {
            return Err(invalid("icon", "must be a data: URL of at most 2048 bytes"));
        }
        if self
            .description
            .as_ref()
            .is_some_and(|d| d.len() > MAX_DESCRIPTION_LEN)
        {
            return Err(invalid("description", "must be at most 280 bytes"));
        }
        if self
            .website
            .as_ref()
            .is_some_and(|w| w.len() > MAX_WEBSITE_LEN)
        {
            return Err(invalid("website", "must be at most 200 bytes"));
        }

        let (total_supply, sale_supply) = (self.total_supply.0, self.sale_supply.0);
        if sale_supply == 0 || sale_supply > total_supply {
            return Err(invalid(
                "sale_supply",
                "must satisfy 0 < sale_supply <= total_supply",
            ));
        }
        let floor_price = self.floor_price.0;
        if floor_price == 0 {
            return Err(invalid("floor_price", "must be positive"));
        }
        let max_price = self.max_price.map(|p| p.0);
        if max_price.is_some_and(|ceiling| ceiling < floor_price) {
            return Err(invalid("max_price", "must be at least floor_price"));
        }

        let (bid_start, bid_end) = (self.bid_start.0, self.bid_end.0);
        if bid_start < now {
            return Err(invalid("bid_start", "must not be in the past"));
        }
        if bid_end <= bid_start {
            return Err(invalid("bid_end", "must be after bid_start"));
        }
        if bid_end - bid_start > MAX_BID_WINDOW_NS {
            return Err(invalid("bid_end", "the bid window must be at most 30 days"));
        }

        let (min_deposit, max_deposit) = (self.min_deposit.0, self.max_deposit_per_account.0);
        if min_deposit < MIN_DEPOSIT_FLOOR || min_deposit > max_deposit {
            return Err(invalid(
                "min_deposit",
                "must satisfy 1 USDC (1000000) <= min_deposit <= max_deposit_per_account",
            ));
        }
        // Keeps every clearing intermediate inside u128 (see the clearing crate).
        let fits = one_token(self.decimals).and_then(|one| max_deposit.checked_mul(one));
        if fits.is_none() {
            return Err(invalid(
                "max_deposit_per_account",
                "max_deposit_per_account * 10^decimals must fit in u128",
            ));
        }
        if self.max_bids == 0 || self.max_bids > MAX_BIDS_PER_SALE {
            return Err(invalid(
                "max_bids",
                "must be between 1 and MAX_BIDS_PER_SALE",
            ));
        }

        let reveal_window = match self.reveal_mode {
            RevealMode::Tee => {
                if self.reveal_window.is_some() {
                    return Err(invalid(
                        "reveal_window",
                        "applies to CommitReveal sales only",
                    ));
                }
                0
            }
            RevealMode::CommitReveal => {
                let window = self.reveal_window.map_or(DEFAULT_REVEAL_WINDOW_NS, |w| w.0);
                if !(MIN_REVEAL_WINDOW_NS..=MAX_REVEAL_WINDOW_NS).contains(&window) {
                    return Err(invalid(
                        "reveal_window",
                        "must be between 1 minute and 7 days",
                    ));
                }
                window
            }
        };
        let settle_timeout = self.settle_timeout.0;
        if !(MIN_SETTLE_TIMEOUT_NS..=MAX_SETTLE_TIMEOUT_NS).contains(&settle_timeout) {
            return Err(invalid(
                "settle_timeout",
                "must be between 10 minutes and 7 days",
            ));
        }
        if !config.allows_quote_token(&self.quote_token) {
            return Err(Error::QuoteTokenNotAllowed);
        }
        let liquidity = match self.liquidity {
            Some(params) => Some(params.validate(total_supply, sale_supply, config)?),
            None => None,
        };

        Ok(NewSale {
            sale_id: self.sale_id,
            token,
            terms: SaleTerms {
                total_supply,
                sale_supply,
                decimals: self.decimals,
                floor_price,
                max_price,
                min_raise: self.min_raise.0,
                bid_start,
                bid_end,
                min_deposit,
                max_deposit,
                max_bids: self.max_bids,
            },
            meta: SaleMeta {
                token_name: self.token_name,
                token_symbol: self.token_symbol,
                icon: self.icon,
                description: self.description,
                website: self.website,
            },
            reveal_mode: self.reveal_mode,
            reveal_window,
            settle_timeout,
            quote_token: self.quote_token,
            liquidity,
        })
    }
}

/// `^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$`. Every sale id from outside is
/// checked with this before a storage lookup: a key longer than the protocol
/// allows makes the lookup panic.
pub(crate) fn valid_sale_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    let alnum = |b: &u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    match bytes {
        [] => false,
        [only] => alnum(only),
        [first, middle @ .., last] => {
            bytes.len() <= MAX_SALE_ID_LEN
                && alnum(first)
                && alnum(last)
                && middle.iter().all(|b| alnum(b) || *b == b'_' || *b == b'-')
        }
    }
}

#[cfg(test)]
mod tests {
    use super::valid_sale_id;

    #[test]
    fn sale_id_pattern() {
        for ok in ["a", "7", "fairt", "my-sale_1", "a-b", &"a".repeat(32)] {
            assert!(valid_sale_id(ok), "{ok}");
        }
        for bad in ["", "-a", "a-", "_", "A", "a.b", "a b", &"a".repeat(33), "ä"] {
            assert!(!valid_sale_id(bad), "{bad}");
        }
    }
}
