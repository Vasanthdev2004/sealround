//! Fairground: sealed-bid, uniform-price batch auctions for NEAR token launches.
//!
//! One contract holds every sale. `create_sale` deploys the sale's token to
//! `<sale_id>.<this account>` and, in TEE mode, asks the OutLayer sealer job for
//! the sale's public key. Bids arrive as USDC `ft_transfer_call`s carrying a
//! sealed ciphertext (TEE) or a commitment (commit-reveal). After the window,
//! `close_sale` sends every bid to the sealer, which decrypts and clears them
//! inside the enclave; the contract checks what it can of the result and
//! settles. Commit-reveal sales clear on chain after a reveal window instead.
//! Settled and Failed are both final and let everyone claim.
//!
//! There is no owner, no admin and no upgrade method. See `contracts/DESIGN.md`.

mod bids;
mod claims;
mod config;
mod costs;
mod error;
mod events;
mod outlayer;
mod sale;
mod settle;
mod setup;
mod views;

#[cfg(test)]
mod tests;

use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, PanicOnDefault, PromiseError, env, ext_contract, near,
};
use sale::valid_sale_id;

pub use bids::BidRecord;
pub use config::{Config, SealerSource, SecretsRef};
pub use costs::MAX_BIDS_PER_SALE;
pub use error::Error;
pub use sale::{
    CreateSaleParams, FailReason, Phase, RevealMode, Sale, SaleMeta, Status, StepState, UnsoldRule,
};
pub use views::{BidView, BidsSummary, FillView, ProceedsView, ResultView, SaleView};

/// Storage prefixes. Per-sale data is keyed by the sale's number (its position
/// in `sale_ids`), which keeps keys short.
#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    SaleIds,
    Sales,
    Meta,
    Bids,
    BidIndex,
    Deposits,
    Fills,
    QuoteTokens,
    InvalidBids,
}

/// `(sale number, bid index)`.
type BidKey = (u32, u32);
/// `(sale number, bidder)`.
type BidderKey = (u32, AccountId);

/// The NEP-141/NEP-145 calls this contract makes on the sale token and the
/// quote token (plus the sale token's own `burn`).
#[ext_contract(ext_ft)]
#[allow(
    dead_code,
    reason = "a declaration of the other contract's methods; only the generated ext_ft is used"
)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
    fn burn(&mut self, amount: U128);
}

/// Whether promise result `index` succeeded. Never panics: a missing result
/// counts as a failure, a result too long to read as a success.
fn promise_succeeded(index: u64) -> bool {
    index < env::promise_results_count()
        && matches!(
            env::promise_result_checked(index, 4096),
            Ok(_) | Err(PromiseError::TooLong(_))
        )
}

/// Fails early, with the amount to attach, when the call's remaining gas
/// cannot cover `needed` (instead of failing halfway through creating promises).
fn require_gas(needed: Gas) -> Result<(), Error> {
    let used = env::used_gas();
    if env::prepaid_gas().saturating_sub(used) < needed {
        return Err(Error::NotEnoughGas {
            required: used.saturating_add(needed),
        });
    }
    Ok(())
}

#[near(
    contract_state,
    contract_metadata(standard(standard = "nep297", version = "1.0.0"))
)]
#[derive(PanicOnDefault)]
pub struct Fairground {
    config: Config,
    /// Sale ids in creation order; a sale's number is its index here.
    sale_ids: Vector<String>,
    /// Hot sale record: read and written on every bid.
    sales: LookupMap<String, Sale>,
    /// Display data and token metadata, fixed at creation. Kept apart so bids
    /// never load the icon.
    meta: LookupMap<u32, SaleMeta>,
    bids: LookupMap<BidKey, BidRecord>,
    /// One bid per account per sale.
    bid_index: LookupMap<BidderKey, u32>,
    /// Every bid's deposit, in bid order, packed in one value per sale so
    /// settlement reads one storage value instead of one per bid.
    deposits: LookupMap<u32, Vec<u128>>,
    /// Settled fills `(tokens, spent)`, in bid order, one value per sale.
    fills: LookupMap<u32, Vec<(u128, u128)>>,
    /// This contract's own storage registration on each quote token.
    quote_tokens: LookupMap<AccountId, StepState>,
    /// Indices of the bids that pay the invalid-bid penalty, ascending, one
    /// value per sale. Written only when a checked enclave result or
    /// `clear_onchain` finds invalid bids.
    invalid_bids: LookupMap<u32, Vec<u32>>,
}

#[near]
impl Fairground {
    /// Sets the fixed configuration. `#[private]`: only the contract account
    /// itself (at deploy time) can initialise it, so nobody can front-run the
    /// init with their own sealer.
    #[init]
    #[private]
    #[handle_result]
    pub fn new(
        outlayer: AccountId,
        sealer_source: SealerSource,
        sealer_code_hash: String,
        sealer_secrets: Option<SecretsRef>,
        allowed_quote_tokens: Vec<AccountId>,
    ) -> Result<Self, Error> {
        let config = Config {
            outlayer,
            sealer_source,
            sealer_code_hash,
            sealer_secrets,
            allowed_quote_tokens,
        };
        config.validate()?;
        Ok(Self {
            config,
            sale_ids: Vector::new(StorageKey::SaleIds),
            sales: LookupMap::new(StorageKey::Sales),
            meta: LookupMap::new(StorageKey::Meta),
            bids: LookupMap::new(StorageKey::Bids),
            bid_index: LookupMap::new(StorageKey::BidIndex),
            deposits: LookupMap::new(StorageKey::Deposits),
            fills: LookupMap::new(StorageKey::Fills),
            quote_tokens: LookupMap::new(StorageKey::QuoteTokens),
            invalid_bids: LookupMap::new(StorageKey::InvalidBids),
        })
    }
}

impl Fairground {
    /// The sale with this id. An id that breaks the sale id rule is never
    /// looked up: it names no sale, and a long one would make the storage
    /// read panic (keys are at most 2048 bytes).
    fn find_sale(&self, sale_id: &str) -> Option<&Sale> {
        if !valid_sale_id(sale_id) {
            return None;
        }
        self.sales.get(sale_id)
    }

    fn sale(&self, sale_id: &str) -> Result<&Sale, Error> {
        self.find_sale(sale_id).ok_or(Error::UnknownSale)
    }

    fn sale_mut(&mut self, sale_id: &str) -> Result<&mut Sale, Error> {
        if !valid_sale_id(sale_id) {
            return Err(Error::UnknownSale);
        }
        self.sales.get_mut(sale_id).ok_or(Error::UnknownSale)
    }

    fn sale_deposits(&self, num: u32) -> &[u128] {
        self.deposits.get(&num).map_or(&[], Vec::as_slice)
    }

    /// Whether bid `index` of sale `num` pays the invalid-bid penalty.
    fn is_penalized(&self, num: u32, index: u32) -> bool {
        self.invalid_bids
            .get(&num)
            .is_some_and(|invalid| invalid.binary_search(&index).is_ok())
    }

    fn bid_record(&self, num: u32, index: u32) -> Option<&BidRecord> {
        self.bids.get(&(num, index))
    }

    /// Writes every cached collection entry to storage. Unit tests use it to
    /// measure storage; on chain the SDK flushes when the call ends.
    #[cfg(test)]
    fn flush(&mut self) {
        self.sale_ids.flush();
        self.sales.flush();
        self.meta.flush();
        self.bids.flush();
        self.bid_index.flush();
        self.deposits.flush();
        self.fills.flush();
        self.quote_tokens.flush();
        self.invalid_bids.flush();
    }
}
