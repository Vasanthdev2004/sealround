//! Closing and settling: `close_sale`, the OutLayer clearing callback with its
//! checks, commit-reveal (`reveal_bid`, `clear_onchain`) and refund mode.

use fairground_clearing::hash::{SALT_LEN, commitment_preimage, parse_hex};
use fairground_clearing::{
    Bid, ClearingStatus, FailReason as ClearFail, clear, cost_of, one_token,
};
use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::json;
use near_sdk::{AccountId, NearToken, Promise, PromiseOrValue, env, near};

use crate::costs::{
    ON_CLEARING_RESULT_GAS, OWN_WORK_GAS, close_deposit, outlayer_request_gas, request_send_gas,
};
use crate::events::{emit, hex};
use crate::liquidity::{LiquidityStage, deadline_view};
use crate::outlayer::{self, Outcome, SealerReply, clear_input};
use crate::sale::SaleTerms;
use crate::setup::{outcome_label, refund_if_refused};
use crate::{
    Error, FailReason, Fairground, FairgroundExt, Phase, RevealMode, Sale, Status, require_gas,
};

/// Most failed-check names stored with a result (the total is stored too).
pub const MAX_STORED_CHECKS: usize = 8;

/// The penalty on an invalid bid (one the enclave could not use, or a
/// commit-reveal bid unrevealed or revealed invalid): 1 % of its deposit,
/// rounded up. It makes filling a sale's bid slots with junk cost something.
pub fn invalid_bid_penalty(deposit: u128) -> u128 {
    deposit.div_ceil(100)
}

/// A well-formed `op: clear`, `ok: true` sealer reply.
struct ClearOutput {
    sale_id: String,
    bid_set_hash: String,
    /// The sale key the sealer derived (hex): bids were sealed to it.
    pubkey: String,
    clearing_price: u128,
    n_valid: u32,
    n_invalid: u32,
    /// Indices of the invalid bids, claimed ascending.
    invalid: Vec<u32>,
    fills: Vec<(u128, u128)>,
}

impl ClearOutput {
    fn from_reply(reply: SealerReply) -> Option<Self> {
        if reply.op.as_deref() != Some("clear") {
            return None;
        }
        Some(Self {
            sale_id: reply.sale_id?,
            bid_set_hash: reply.bid_set_hash?,
            pubkey: reply.pubkey?,
            clearing_price: reply.clearing_price?.0,
            n_valid: reply.n_valid?,
            n_invalid: reply.n_invalid?,
            invalid: reply.invalid?,
            fills: reply
                .fills?
                .into_iter()
                .map(|(tokens, spent)| (tokens.0, spent.0))
                .collect(),
        })
    }
}

/// Failed checks, by name, in the order they ran.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct CheckReport {
    names: Vec<String>,
    total: u32,
    /// A check other than `raise_at_least_min` / `something_sold` failed:
    /// the result cannot be trusted.
    integrity_failed: bool,
}

impl CheckReport {
    fn failed(&mut self, name: &str, integrity: bool) {
        self.record(|| name.to_owned(), integrity);
    }

    /// A failed per-bid check, named `<name>_<index>`.
    fn failed_at(&mut self, name: &str, index: usize, integrity: bool) {
        self.record(|| format!("{name}_{index}"), integrity);
    }

    /// Counts a failure; builds its name only if it is stored, since a bad
    /// result can fail two checks per bid.
    fn record(&mut self, name: impl FnOnce() -> String, integrity: bool) {
        if self.names.len() < MAX_STORED_CHECKS {
            self.names.push(name());
        }
        self.total = self.total.saturating_add(1);
        self.integrity_failed |= integrity;
    }

    fn single(name: &str) -> Self {
        let mut report = Self::default();
        report.failed(name, true);
        report
    }
}

/// Totals of a checked result.
struct Totals {
    sold: u128,
    raised: u128,
}

/// Every check DESIGN lists, against public data only: the sale terms, the
/// sale key, the bid count, the stored bid-set hash and each bid's deposit.
fn check_clear_output(
    sale_id: &str,
    sale: &Sale,
    deposits: &[u128],
    out: &ClearOutput,
) -> (CheckReport, Totals) {
    let mut report = CheckReport::default();
    let terms = &sale.terms;
    let price = out.clearing_price;
    if out.sale_id != sale_id {
        report.failed("sale_id_matches", true);
    }
    if out.bid_set_hash != hex(&sale.bid_set_state) {
        report.failed("bid_set_hash_matches", true);
    }
    // A different key (say the master secret changed) cannot open the bids
    // sealed to the published one: none of its "invalid" verdicts count.
    if sale.sealer_pubkey.map(|key| hex(&key)).as_deref() != Some(out.pubkey.as_str()) {
        report.failed("pubkey_matches", true);
    }
    if out.fills.len() != sale.bid_count as usize {
        report.failed("one_fill_per_bid", true);
    }
    let listed = invalid_flags(&out.invalid, sale.bid_count);
    let counts_add_up = u64::from(out.n_valid) + u64::from(out.n_invalid)
        == u64::from(sale.bid_count)
        && out.invalid.len() == out.n_invalid as usize;
    if listed.is_none() || !counts_add_up {
        report.failed("invalid_list_matches", true);
    }
    if price < terms.floor_price {
        report.failed("price_at_least_floor", true);
    }
    if terms.max_price.is_some_and(|ceiling| price > ceiling) {
        report.failed("price_at_most_ceiling", true);
    }
    let sold = checked_sum(out.fills.iter().map(|fill| fill.0));
    if sold.is_none_or(|sold| sold > terms.sale_supply) {
        report.failed("sold_at_most_supply", true);
    }
    // decimals <= 24 was checked at creation, so ONE always exists.
    let one = one_token(terms.decimals).unwrap_or(1);
    for (i, &(tokens, spent)) in out.fills.iter().enumerate() {
        if deposits.get(i).is_some_and(|&deposit| spent > deposit) {
            report.failed_at("spent_within_deposit", i, true);
        }
        if cost_of(tokens, price, one) != Some(spent) {
            report.failed_at("spent_equals_tokens_times_price", i, true);
        }
        let invalid = listed
            .as_ref()
            .is_some_and(|flags| flags.get(i).copied().unwrap_or(false));
        if invalid && tokens > 0 {
            report.failed_at("invalid_bid_unfilled", i, true);
        }
    }
    // Each spent is within its deposit and the deposits' sum fits u128, so an
    // overflow here has already failed an integrity check.
    let raised = checked_sum(out.fills.iter().map(|fill| fill.1));
    if raised.is_none_or(|raised| raised < terms.min_raise) {
        report.failed("raise_at_least_min", false);
    }
    if sold == Some(0) {
        report.failed("something_sold", false);
    }
    let totals = Totals {
        sold: sold.unwrap_or(0),
        raised: raised.unwrap_or(0),
    };
    (report, totals)
}

fn checked_sum(mut values: impl Iterator<Item = u128>) -> Option<u128> {
    values.try_fold(0u128, u128::checked_add)
}

/// One flag per bid from a list of invalid bid indices, or `None` unless the
/// list is strictly ascending and every index names a bid.
fn invalid_flags(invalid: &[u32], bid_count: u32) -> Option<Vec<bool>> {
    let ascending = invalid.windows(2).all(|pair| pair[0] < pair[1]);
    if !ascending || invalid.last().is_some_and(|&last| last >= bid_count) {
        return None;
    }
    let mut flags = vec![false; bid_count as usize];
    for &index in invalid {
        flags[index as usize] = true;
    }
    Some(flags)
}

/// The penalties of the bids at `invalid`, given every bid's deposit.
fn penalties_of(invalid: &[u32], deposits: &[u128]) -> u128 {
    invalid
        .iter()
        .filter_map(|&index| deposits.get(index as usize))
        .map(|&deposit| invalid_bid_penalty(deposit))
        .fold(0, u128::saturating_add)
}

/// How a result that passed the integrity checks ends.
fn outcome_reason(terms: &SaleTerms, totals: &Totals, n_valid: u32) -> Option<FailReason> {
    if totals.sold == 0 {
        Some(if n_valid == 0 {
            FailReason::NoValidBids
        } else if terms.min_raise > 0 {
            FailReason::BelowMinRaise
        } else {
            FailReason::NothingSold
        })
    } else if totals.raised < terms.min_raise {
        Some(FailReason::BelowMinRaise)
    } else {
        None
    }
}

#[near]
impl Fairground {
    /// Closes a sale after `bid_end` (anyone), freezing the bid set. No bids:
    /// the sale fails. Commit-reveal: the reveal window opens. TEE: sends every
    /// bid to the sealer; attach at least `get_close_deposit(sale_id)` (you are
    /// the OutLayer payer and get back what it does not charge). Also retries a
    /// `closed` sale whose clearing failed. Returns the new status.
    #[payable]
    #[handle_result]
    pub fn close_sale(&mut self, sale_id: String) -> Result<PromiseOrValue<String>, Error> {
        let now = env::block_timestamp();
        let caller = env::predecessor_account_id();
        let attached = env::attached_deposit();
        let sale = self.sale(&sale_id)?;
        match sale.phase {
            Phase::Bidding if now >= sale.terms.bid_end => {}
            Phase::Bidding => {
                return Err(Error::TooEarly {
                    action: "close the sale",
                    at: sale.terms.bid_end,
                });
            }
            Phase::Closed => {}
            _ => {
                return Err(Error::WrongPhase {
                    action: "close the sale",
                    status: sale.status(now).as_str(),
                });
            }
        }
        let first_close = sale.closed_at.is_none();
        let closed_at = sale.closed_at.unwrap_or(now);

        if sale.bid_count == 0 || sale.reveal_mode == RevealMode::CommitReveal {
            let no_bids = sale.bid_count == 0;
            refund(&caller, attached);
            let sale = self.sale_mut(&sale_id)?;
            sale.closed_at = Some(closed_at);
            if !no_bids {
                sale.phase = Phase::Revealing;
            }
            emit_sale_closed(&sale_id, sale);
            let status = if no_bids {
                self.fail_sale(&sale_id, FailReason::NoBids, CheckReport::default())
            } else {
                Status::Revealing
            };
            return Ok(PromiseOrValue::Value(status.as_str().to_owned()));
        }

        let input = self.clear_input_for(&sale_id, sale);
        let required = close_deposit(input.len());
        if attached.as_yoctonear() < required {
            return Err(Error::DepositTooLow {
                required,
                attached: attached.as_yoctonear(),
            });
        }
        let input_sha256 = env::sha256_array(input.as_bytes());
        let args = outlayer::request_args(&self.config, &input, &caller);
        let input_len = input.len();
        drop(input);
        // What the rest of this call needs: the gas it attaches, plus sending
        // the arguments, which costs gas per byte (see `request_send_gas`).
        require_gas(
            outlayer_request_gas(input_len)
                .saturating_add(ON_CLEARING_RESULT_GAS)
                .saturating_add(request_send_gas(args.len()))
                .saturating_add(OWN_WORK_GAS),
        )?;
        let sale = self.sale_mut(&sale_id)?;
        sale.closed_at = Some(closed_at);
        sale.phase = Phase::Clearing;
        sale.result.clear_requests = sale.result.clear_requests.saturating_add(1);
        sale.result.clear_request_block = Some(env::block_height());
        sale.result.input_sha256 = Some(input_sha256);
        if first_close {
            emit_sale_closed(&sale_id, sale);
        }
        emit(
            "clearing_requested",
            json!({
                "sale_id": sale_id,
                "request": sale.result.clear_requests,
                "closer": caller,
                "deposit": U128(attached.as_yoctonear()),
                "input_bytes": input_len,
                "input_sha256": hex(&input_sha256),
            }),
        );
        let promise = outlayer::send_request(&self.config, args, input_len, attached).then(
            Self::ext(env::current_account_id())
                .with_static_gas(ON_CLEARING_RESULT_GAS)
                .on_clearing_result(sale_id, caller, U128(attached.as_yoctonear())),
        );
        Ok(PromiseOrValue::Promise(promise))
    }

    /// The sealer's clearing result. Reads the raw promise result and never
    /// panics. `Err` / `null` / `""` / any answer with `ok:false` (whatever
    /// its `op`, `sale_id` or `v`): the sale goes to `closed` for a retry,
    /// and `clearing_failed` carries the reason (`sealer_error: <code>` for an
    /// `ok:false` answer). Otherwise the result is checked: malformed output
    /// or any failed check fails the sale (everyone is refunded), a result
    /// below the minimum raise or with nothing sold fails it too, and a
    /// passing result settles it. Returns the status.
    #[private]
    pub fn on_clearing_result(
        &mut self,
        sale_id: String,
        closer: AccountId,
        deposit: U128,
    ) -> String {
        let outcome = outlayer::read_outcome();
        refund_if_refused(&outcome, &closer, deposit.0);
        let now = env::block_timestamp();
        let Some(sale) = self.sales.get(&sale_id) else {
            return "unknown_sale".to_owned();
        };
        if sale.phase != Phase::Clearing {
            env::log_str("clearing result ignored: the sale is no longer clearing");
            return sale.status(now).as_str().to_owned();
        }
        let status = match outcome {
            Outcome::Output { sha256, reply } => {
                if let Some(sale) = self.sales.get_mut(&sale_id) {
                    sale.result.result_sha256 = Some(sha256);
                }
                match reply {
                    // A refusal comes first: it is never "malformed", even
                    // with `op` and `sale_id` null.
                    Ok(reply) if !reply.ok => self.retry_clearing(&sale_id, &reply.error_label()),
                    Err(why) => {
                        env::log_str(&format!("malformed sealer output: {why}"));
                        self.fail_sale(
                            &sale_id,
                            FailReason::ChecksFailed,
                            CheckReport::single("output_well_formed"),
                        )
                    }
                    Ok(reply) => self.apply_clear_reply(&sale_id, reply),
                }
            }
            other => self.retry_clearing(&sale_id, outcome_label(&other)),
        };
        status.as_str().to_owned()
    }

    /// Commit-reveal: the bidder reveals `max_price`, `max_spend` and the 16-byte
    /// salt (32 hex characters) of its commitment, before the reveal window ends.
    #[handle_result]
    pub fn reveal_bid(
        &mut self,
        sale_id: String,
        max_price: U128,
        max_spend: U128,
        salt: String,
    ) -> Result<(), Error> {
        let now = env::block_timestamp();
        let bidder = env::predecessor_account_id();
        let sale = self.sale(&sale_id)?;
        if sale.phase != Phase::Revealing {
            return Err(Error::WrongPhase {
                action: "reveal a bid",
                status: sale.status(now).as_str(),
            });
        }
        let reveal_end = sale.reveal_end().unwrap_or(0);
        if now >= reveal_end {
            return Err(Error::TooLate {
                action: "reveal a bid",
                at: reveal_end,
            });
        }
        let num = sale.num;
        let index = *self
            .bid_index
            .get(&(num, bidder.clone()))
            .ok_or(Error::NoBid)?;
        let salt = parse_hex::<SALT_LEN>(&salt).ok_or(Error::BadSalt)?;
        let record = self.bids.get_mut(&(num, index)).ok_or(Error::NoBid)?;
        if record.reveal.is_some() {
            return Err(Error::AlreadyRevealed);
        }
        let commitment = env::sha256_array(commitment_preimage(
            &sale_id,
            bidder.as_str(),
            max_price.0,
            max_spend.0,
            &salt,
        ));
        if record.payload != commitment {
            return Err(Error::CommitmentMismatch);
        }
        record.reveal = Some((max_price.0, max_spend.0));
        emit(
            "bid_revealed",
            json!({ "sale_id": sale_id, "bidder": bidder, "index": index }),
        );
        Ok(())
    }

    /// Commit-reveal: clears the sale on chain once the reveal window has
    /// ended (anyone). Invalid bids (unrevealed, or revealed but breaking a
    /// bid rule) pay a 1 % penalty (rounded up) that stays locked in this
    /// contract for good.
    #[handle_result]
    pub fn clear_onchain(&mut self, sale_id: String) -> Result<String, Error> {
        let now = env::block_timestamp();
        let sale = self.sale(&sale_id)?;
        if sale.phase != Phase::Revealing {
            return Err(Error::WrongPhase {
                action: "clear on chain",
                status: sale.status(now).as_str(),
            });
        }
        let reveal_end = sale.reveal_end().unwrap_or(0);
        if now < reveal_end {
            return Err(Error::TooEarly {
                action: "clear on chain",
                at: reveal_end,
            });
        }
        let num = sale.num;
        let deposits = self.sale_deposits(num);
        let mut bids = Vec::with_capacity(sale.bid_count as usize);
        for index in 0..sale.bid_count {
            let record = self.bid_record(num, index);
            let reveal = record.and_then(|record| record.reveal);
            bids.push(Bid {
                bidder: record
                    .map(|record| record.bidder.to_string())
                    .unwrap_or_default(),
                deposit: deposits.get(index as usize).copied().unwrap_or(0),
                max_price: reveal.map(|(price, _)| price),
                max_spend: reveal.map(|(_, spend)| spend),
                mismatch: false,
            });
        }
        let result = clear(&sale.terms.clearing_params(), &bids);

        let sale = self.sale_mut(&sale_id)?;
        if let Ok(result) = &result {
            sale.result.clearing_price = result.clearing_price;
            sale.result.n_valid = u32::try_from(result.n_valid).unwrap_or(u32::MAX);
            sale.result.n_invalid = u32::try_from(result.n_invalid).unwrap_or(u32::MAX);
            // Unrevealed bids and revealed ones that break a bid rule.
            let invalid = result
                .fills
                .iter()
                .filter(|fill| !fill.valid)
                .filter_map(|fill| u32::try_from(fill.index).ok())
                .collect();
            self.penalize(&sale_id, num, invalid);
        }
        let status = match result {
            // Params were validated at creation, so this does not happen.
            Err(error) => self.fail_sale(
                &sale_id,
                FailReason::ChecksFailed,
                CheckReport::single(error.code()),
            ),
            Ok(result) => match (result.status, result.fail_reason) {
                (ClearingStatus::Settled, _) if result.total_sold > 0 => {
                    let fills = result
                        .fills
                        .iter()
                        .map(|fill| (fill.tokens, fill.spent))
                        .collect();
                    self.settle(&sale_id, fills, result.total_sold, result.total_raised)
                }
                (ClearingStatus::Settled, _) => self.fail_sale(
                    &sale_id,
                    FailReason::NothingSold,
                    named_check("something_sold"),
                ),
                (ClearingStatus::Failed, Some(ClearFail::NoValidBids)) => self.fail_sale(
                    &sale_id,
                    FailReason::NoValidBids,
                    named_check("something_sold"),
                ),
                (ClearingStatus::Failed, _) => self.fail_sale(
                    &sale_id,
                    FailReason::BelowMinRaise,
                    named_check("raise_at_least_min"),
                ),
            },
        };
        Ok(status.as_str().to_owned())
    }

    /// After the settle timeout, anyone can move an unsettled sale to failed so
    /// every deposit can be claimed back. The timeout counts from the close
    /// (from the end of the reveal window in commit-reveal), else from `bid_end`.
    #[handle_result]
    pub fn trigger_refund_mode(&mut self, sale_id: String) -> Result<(), Error> {
        let now = env::block_timestamp();
        let sale = self.sale(&sale_id)?;
        let status = sale.status(now);
        let Some(at) = sale.refund_mode_at() else {
            return Err(Error::WrongPhase {
                action: "trigger refund mode",
                status: status.as_str(),
            });
        };
        if now < at {
            return Err(Error::TooEarly {
                action: "trigger refund mode",
                at,
            });
        }
        emit(
            "refund_mode",
            json!({ "sale_id": sale_id, "from": status.as_str() }),
        );
        self.fail_sale(&sale_id, FailReason::RefundMode, CheckReport::default());
        Ok(())
    }
}

impl Fairground {
    /// The clearing input for a sale, built from its bid book.
    pub(crate) fn clear_input_for(&self, sale_id: &str, sale: &Sale) -> String {
        let num = sale.num;
        let deposits = self.sale_deposits(num);
        let bids = (0..sale.bid_count).filter_map(|index| {
            let record = self.bid_record(num, index)?;
            let deposit = *deposits.get(index as usize)?;
            Some((&record.bidder, deposit, record.payload.as_slice()))
        });
        clear_input(
            &env::current_account_id(),
            sale_id,
            &sale.terms,
            &hex(&sale.bid_set_state),
            sale.bid_count,
            bids,
        )
    }

    fn apply_clear_reply(&mut self, sale_id: &str, reply: SealerReply) -> Status {
        let Some(out) = ClearOutput::from_reply(reply) else {
            env::log_str("malformed sealer output: not a complete clear result");
            return self.fail_sale(
                sale_id,
                FailReason::ChecksFailed,
                CheckReport::single("output_well_formed"),
            );
        };
        let Some(sale) = self.sales.get(sale_id) else {
            return Status::Failed;
        };
        let num = sale.num;
        let deposits = self.sale_deposits(num);
        let (report, totals) = check_clear_output(sale_id, sale, deposits, &out);
        let reason = if report.integrity_failed {
            Some(FailReason::ChecksFailed)
        } else {
            outcome_reason(&sale.terms, &totals, out.n_valid)
        };
        if let Some(sale) = self.sales.get_mut(sale_id) {
            sale.result.clearing_price = out.clearing_price;
            sale.result.n_valid = out.n_valid;
            sale.result.n_invalid = out.n_invalid;
        }
        // Only a result that passed every integrity check may name the bids
        // that pay the penalty; a result failing one refunds everyone in full.
        if !report.integrity_failed {
            self.penalize(sale_id, num, out.invalid);
        }
        match reason {
            Some(reason) => self.fail_sale(sale_id, reason, report),
            None => self.settle(sale_id, out.fills, totals.sold, totals.raised),
        }
    }

    /// Records the bids that pay the invalid-bid penalty (indices ascending)
    /// and their total. Called once, when a trusted clearing decides the sale.
    fn penalize(&mut self, sale_id: &str, num: u32, invalid: Vec<u32>) {
        if invalid.is_empty() {
            return;
        }
        let total = penalties_of(&invalid, self.sale_deposits(num));
        if let Some(sale) = self.sales.get_mut(sale_id) {
            sale.result.total_penalties = total;
        }
        self.invalid_bids.insert(num, invalid);
    }

    /// Settles a sale with checked fills, and fixes its launch pool's amounts.
    fn settle(
        &mut self,
        sale_id: &str,
        fills: Vec<(u128, u128)>,
        sold: u128,
        raised: u128,
    ) -> Status {
        let now = env::block_timestamp();
        let dex = self.config.dex.clone();
        let Some(sale) = self.sales.get_mut(sale_id) else {
            return Status::Failed;
        };
        let n_winners = fills.iter().filter(|fill| fill.0 > 0).count();
        sale.phase = Phase::Settled;
        sale.result.total_sold = sold;
        sale.result.total_raised = raised;
        sale.result.n_winners = u32::try_from(n_winners).unwrap_or(u32::MAX);
        let num = sale.num;
        emit(
            "sale_settled",
            json!({
                "sale_id": sale_id,
                "clearing_price": U128(sale.result.clearing_price),
                "total_sold": U128(sold),
                "total_raised": U128(raised),
                "unsold": U128(sale.terms.sale_supply.saturating_sub(sold)),
                "n_valid": sale.result.n_valid,
                "n_invalid": sale.result.n_invalid,
                "n_winners": sale.result.n_winners,
                "result_sha256": sale.result.result_sha256.as_ref().map(|h| hex(h)),
            }),
        );
        if let Some(liquidity) = sale.liquidity.as_mut() {
            let price = sale.result.clearing_price;
            let deadline = now.saturating_add(sale.settle_timeout);
            liquidity.plan(raised, price, sale.terms.decimals, deadline);
            emit(
                "liquidity_planned",
                json!({
                    "sale_id": sale_id,
                    "dex": dex,
                    "stage": liquidity.stage,
                    "usdc": U128(liquidity.usdc),
                    "tokens": U128(liquidity.tokens),
                    "price": U128(price),
                    "unused_tokens": U128(liquidity.pool_tokens - liquidity.tokens),
                    "deadline": deadline_view(liquidity),
                }),
            );
        }
        self.fills.insert(num, fills);
        Status::Settled
    }

    /// Fails a sale: everyone gets their deposit back (minus the invalid-bid
    /// penalty when a trusted clearing decided it).
    pub(crate) fn fail_sale(
        &mut self,
        sale_id: &str,
        reason: FailReason,
        checks: CheckReport,
    ) -> Status {
        let Some(sale) = self.sales.get_mut(sale_id) else {
            return Status::Failed;
        };
        sale.phase = Phase::Failed;
        sale.result.fail_reason = Some(reason);
        sale.result.total_sold = 0;
        sale.result.total_raised = 0;
        sale.result.n_winners = 0;
        sale.result.failed_checks = checks.names;
        sale.result.failed_checks_total = checks.total;
        if let Some(liquidity) = sale.liquidity.as_mut() {
            liquidity.stage = LiquidityStage::Cancelled;
        }
        emit(
            "sale_failed",
            json!({
                "sale_id": sale_id,
                "reason": reason.as_str(),
                "failed_checks": sale.result.failed_checks,
                "failed_checks_total": sale.result.failed_checks_total,
                "result_sha256": sale.result.result_sha256.as_ref().map(|h| hex(h)),
            }),
        );
        Status::Failed
    }

    /// A clearing attempt that the enclave did not complete: back to `closed`
    /// so `close_sale` can retry.
    fn retry_clearing(&mut self, sale_id: &str, reason: &str) -> Status {
        let Some(sale) = self.sales.get_mut(sale_id) else {
            return Status::Failed;
        };
        sale.phase = Phase::Closed;
        sale.result.clear_attempts = sale.result.clear_attempts.saturating_add(1);
        emit(
            "clearing_failed",
            json!({
                "sale_id": sale_id,
                "attempt": sale.result.clear_attempts,
                "reason": reason,
            }),
        );
        Status::Closed
    }
}

fn named_check(name: &str) -> CheckReport {
    let mut report = CheckReport::default();
    report.failed(name, false);
    report
}

fn emit_sale_closed(sale_id: &str, sale: &Sale) {
    emit(
        "sale_closed",
        json!({
            "sale_id": sale_id,
            "closed_at": sale.closed_at.map(U64),
            "bid_count": sale.bid_count,
            "total_deposits": U128(sale.total_deposits),
            "bid_set_hash": hex(&sale.bid_set_state),
            "reveal_end": sale.reveal_end().map(U64),
        }),
    );
}

fn refund(account: &AccountId, amount: NearToken) {
    if !amount.is_zero() {
        Promise::new(account.clone()).transfer(amount).detach();
    }
}
