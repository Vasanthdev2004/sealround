//! Placing bids: `ft_on_transfer`, the bid book and the running bid-set hash.

use fairground_clearing::hash::{bid_set_seed_preimage, bid_set_step_preimage, parse_hex};
use fairground_clearing::sealed_bid_len;
use near_sdk::base64::Engine as _;
use near_sdk::base64::engine::general_purpose::STANDARD as BASE64;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{AccountId, PromiseOrValue, env, near};

use crate::costs::{COMMITMENT_BYTES, MAX_CIPHERTEXT_BYTES};
use crate::events::{emit, hex};
use crate::{Fairground, FairgroundExt, RevealMode, valid_sale_id};

/// One bid. Its deposit lives in the sale's packed deposits list.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BidRecord {
    pub bidder: AccountId,
    /// Ciphertext (TEE) or 32-byte commitment (commit-reveal).
    pub payload: Vec<u8>,
    pub placed_at: u64,
    /// Commit-reveal: `(max_price, max_spend)` once revealed.
    pub reveal: Option<(u128, u128)>,
    pub tokens_claimed: bool,
    pub refund_claimed: bool,
}

/// `ft_on_transfer` msg: `{"sale_id":..,"ciphertext":"<base64>"}` or
/// `{"sale_id":..,"commitment":"<hex64>"}`.
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
struct BidMsg {
    sale_id: String,
    #[serde(default)]
    ciphertext: Option<String>,
    #[serde(default)]
    commitment: Option<String>,
}

/// Why a deposit was returned. Logged in the `bid_rejected` event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RejectReason {
    BadMsg,
    UnknownSale,
    WrongToken,
    NotOpen,
    WrongPayload,
    BadBase64,
    CiphertextTooLong,
    /// A TEE ciphertext that is not exactly the length of a sealed bid for
    /// this sale id and bidder (`fairground_clearing::sealed_bid_len`).
    WrongCiphertextLength,
    BadHex,
    BelowMinDeposit,
    AboveMaxDeposit,
    AlreadyBid,
    SaleFull,
    Overflow,
}

impl RejectReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::BadMsg => "bad_msg",
            Self::UnknownSale => "unknown_sale",
            Self::WrongToken => "wrong_token",
            Self::NotOpen => "not_open",
            Self::WrongPayload => "wrong_payload",
            Self::BadBase64 => "bad_base64",
            Self::CiphertextTooLong => "ciphertext_too_long",
            Self::WrongCiphertextLength => "wrong_ciphertext_length",
            Self::BadHex => "bad_hex",
            Self::BelowMinDeposit => "below_min_deposit",
            Self::AboveMaxDeposit => "above_max_deposit",
            Self::AlreadyBid => "already_bid",
            Self::SaleFull => "sale_full",
            Self::Overflow => "overflow",
        }
    }
}

/// `h0` of the bid-set hash.
pub fn bid_set_seed(sale_id: &str) -> [u8; 32] {
    env::sha256_array(bid_set_seed_preimage(sale_id))
}

/// Base64 length of the largest accepted ciphertext; longer text is refused
/// before decoding.
const MAX_CIPHERTEXT_BASE64_LEN: usize = MAX_CIPHERTEXT_BYTES.div_ceil(3) * 4;

#[near]
impl Fairground {
    /// NEP-141 receiver: a deposit of the sale's quote token places a bid.
    /// Never panics on its input. A rejected deposit is returned in full (the
    /// return value is the unused amount) with a `bid_rejected` event.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let (sale_id, reason) = match serde_json::from_str::<BidMsg>(&msg) {
            Ok(bid) => {
                // Only a well-formed id is echoed; anything else logs null.
                let sale_id = valid_sale_id(&bid.sale_id).then(|| bid.sale_id.clone());
                match self.place_bid(&sender_id, amount.0, bid) {
                    Ok(()) => return PromiseOrValue::Value(U128(0)),
                    Err(reason) => (sale_id, reason),
                }
            }
            Err(_) => (None, RejectReason::BadMsg),
        };
        emit(
            "bid_rejected",
            json!({
                "sale_id": sale_id,
                "sender_id": sender_id,
                "token": env::predecessor_account_id(),
                "amount": amount,
                "reason": reason.as_str(),
            }),
        );
        PromiseOrValue::Value(amount)
    }
}

impl Fairground {
    fn place_bid(
        &mut self,
        bidder: &AccountId,
        amount: u128,
        msg: BidMsg,
    ) -> Result<(), RejectReason> {
        let now = env::block_timestamp();
        let sale = self
            .find_sale(&msg.sale_id)
            .ok_or(RejectReason::UnknownSale)?;
        if env::predecessor_account_id() != sale.quote_token {
            return Err(RejectReason::WrongToken);
        }
        if !sale.is_open(now) {
            return Err(RejectReason::NotOpen);
        }
        let payload = match (sale.reveal_mode, &msg.ciphertext, &msg.commitment) {
            (RevealMode::Tee, Some(ciphertext), None) => decode_ciphertext(
                ciphertext,
                sealed_bid_len(msg.sale_id.len(), bidder.as_str().len()),
            )?,
            (RevealMode::CommitReveal, None, Some(commitment)) => {
                parse_hex::<COMMITMENT_BYTES>(commitment)
                    .ok_or(RejectReason::BadHex)?
                    .to_vec()
            }
            _ => return Err(RejectReason::WrongPayload),
        };
        if amount < sale.terms.min_deposit {
            return Err(RejectReason::BelowMinDeposit);
        }
        if amount > sale.terms.max_deposit {
            return Err(RejectReason::AboveMaxDeposit);
        }
        let num = sale.num;
        if self.bid_index.contains_key(&(num, bidder.clone())) {
            return Err(RejectReason::AlreadyBid);
        }
        if sale.bid_count >= sale.terms.max_bids {
            return Err(RejectReason::SaleFull);
        }
        let index = sale.bid_count;
        let total_deposits = sale
            .total_deposits
            .checked_add(amount)
            .ok_or(RejectReason::Overflow)?;
        // Account ids are at most 64 bytes, so the step cannot fail on them.
        let step = bid_set_step_preimage(
            &sale.bid_set_state,
            index,
            bidder.as_str(),
            amount,
            &env::sha256_array(&payload),
        )
        .map_err(|_| RejectReason::Overflow)?;
        let bid_set_state = env::sha256_array(step);

        let sale_id = msg.sale_id;
        if let Some(sale) = self.sales.get_mut(&sale_id) {
            sale.bid_count = index + 1;
            sale.total_deposits = total_deposits;
            sale.bid_set_state = bid_set_state;
        }
        self.bids.insert(
            (num, index),
            BidRecord {
                bidder: bidder.clone(),
                payload,
                placed_at: now,
                reveal: None,
                tokens_claimed: false,
                refund_claimed: false,
            },
        );
        self.bid_index.insert((num, bidder.clone()), index);
        match self.deposits.get_mut(&num) {
            Some(list) => list.push(amount),
            None => {
                self.deposits.insert(num, vec![amount]);
            }
        }
        // Write the bid now rather than when the call ends, so `bid_placed`
        // is logged only after every storage write it reports: a receipt
        // that runs out of gas writing the bid never shows the event. The
        // writes at the end of the call then find nothing left to do.
        self.sales.flush();
        self.bids.flush();
        self.bid_index.flush();
        self.deposits.flush();
        emit(
            "bid_placed",
            json!({
                "sale_id": sale_id,
                "bidder": bidder,
                "index": index,
                "deposit": U128(amount),
                "bid_set_hash": hex(&bid_set_state),
            }),
        );
        Ok(())
    }
}

/// Standard padded base64 of exactly `expected_len` bytes: the length of a
/// sealed bid for this sale id and bidder. The app pads both amounts to 39
/// digits before sealing, so every honest bid in a sale has a length that
/// depends only on the ids; refusing any other length means no bid can show
/// how many digits its price or spend has. Checked in order: base64 longer
/// than the longest bid (`ciphertext_too_long`), not base64 or empty
/// (`bad_base64`), longer than the longest bid once decoded
/// (`ciphertext_too_long`), then any other length (`wrong_ciphertext_length`).
fn decode_ciphertext(text: &str, expected_len: usize) -> Result<Vec<u8>, RejectReason> {
    if text.len() > MAX_CIPHERTEXT_BASE64_LEN {
        return Err(RejectReason::CiphertextTooLong);
    }
    let bytes = BASE64.decode(text).map_err(|_| RejectReason::BadBase64)?;
    if bytes.is_empty() {
        return Err(RejectReason::BadBase64);
    }
    if bytes.len() > MAX_CIPHERTEXT_BYTES {
        return Err(RejectReason::CiphertextTooLong);
    }
    if bytes.len() != expected_len {
        return Err(RejectReason::WrongCiphertextLength);
    }
    Ok(bytes)
}
