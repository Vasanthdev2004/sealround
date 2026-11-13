//! Storage, deposit and gas constants, and the NEAR amounts derived from them.
//!
//! Storage byte counts are measured in the unit tests (`tests::costs`; run with
//! `--nocapture` to print them): the storage the real code writes at its
//! largest, counted as NEAR counts it (key + value + 40 bytes per record). The
//! tests fail if a constant no longer covers its measurement, or sits far above
//! it. Charged amounts add `STORAGE_MARGIN_PERCENT` on top. The sandbox
//! integration tests measure the same sizes on chain (`contracts/GAS.md`).
//! Gas constants come from the sandbox gas calibration in `contracts/tests`
//! (nearcore 2.14.0, OutLayer's real wasm, worst-case bids); `contracts/GAS.md`
//! has the measured table.

use fairground_clearing::sealed_bid_len;
use near_sdk::Gas;

use crate::RevealMode;
use crate::sale::MAX_SALE_ID_LEN;

/// The per-sale token contract, deployed by `create_sale`.
pub const TOKEN_WASM: &[u8] = include_bytes!("../../res/fairground_token.wasm");

/// Longest NEAR account id.
pub const MAX_ACCOUNT_ID_LEN: usize = 64;

/// Most bids one sale accepts. Measured on sandbox 2.14.0 with OutLayer's real
/// wasm and 500 worst-case bids (320-byte ciphertexts, 64-byte bidder ids, a
/// 262,330-byte input): `close_sale`'s gas check asks for 213 TGas of the
/// 300 TGas a transaction can attach (its work before the check +
/// `outlayer_request_gas` + `ON_CLEARING_RESULT_GAS` + `request_send_gas` +
/// `OWN_WORK_GAS`). See contracts/GAS.md for the figures.
pub const MAX_BIDS_PER_SALE: u32 = 500;

/// Longest accepted ciphertext (decoded): a sealed bid for the longest sale id
/// and the longest bidder id, 224 + 32 + 64 = 320 bytes. In TEE mode every
/// bid must be exactly `sealed_bid_len(len(sale_id), len(bidder))` bytes
/// (`bids.rs`); this bound only lets longer text be refused before decoding.
pub const MAX_CIPHERTEXT_BYTES: usize = sealed_bid_len(MAX_SALE_ID_LEN, MAX_ACCOUNT_ID_LEN);
/// A commitment is a sha256.
pub const COMMITMENT_BYTES: usize = 32;

/// Protocol storage price: 1e19 yoctoNEAR per byte.
pub const YOCTO_PER_BYTE: u128 = 10_000_000_000_000_000_000;
/// An account record's storage (`num_bytes_account`).
pub const ACCOUNT_RECORD_BYTES: u64 = 100;
/// NEP-145 registration on a NEP-141 token: 125 bytes, the same for the sale
/// token and every USDC contract checked (min = max = 1.25e21 yoctoNEAR).
pub const TOKEN_STORAGE_DEPOSIT: u128 = 125 * YOCTO_PER_BYTE;
/// Safety margin on storage we pay for in this contract. The byte counts are
/// measured (unit tests and on chain agree to the byte), so the margin only
/// guards against layout changes the tests would also catch.
pub const STORAGE_MARGIN_PERCENT: u128 = 15;

/// Sale storage that does not depend on string lengths: the sale record, its
/// meta record, the `sale_ids` entry, the deposits, fills and invalid-bid
/// values without entries, and the largest result (8 stored check names of
/// 35 bytes). Measured 1,106 bytes at its largest (a failed TEE sale storing 8
/// names of three-digit bids) by `tests::costs::sale_storage_fits_the_formula`.
pub const SALE_BASE_BYTES: u64 = 1_112;
/// The sale id is stored in the `sales` key and in `sale_ids` (and inside the
/// token account id, which is counted with the account ids).
pub const SALE_ID_COPIES: u64 = 2;
/// Bytes one TEE bid adds at most: the record with a 320-byte ciphertext
/// (`MAX_CIPHERTEXT_BYTES`) and a 64-byte bidder, the bidder index entry, its
/// deposit, its fill and its entry in the invalid-bid list. Measured 621 by
/// `tests::costs::bid_storage_fits_the_constants`.
pub const BID_BYTES_TEE: u64 = 624;
/// Same for a commit-reveal bid (32-byte commitment plus its reveal). Measured 365.
pub const BID_BYTES_COMMIT_REVEAL: u64 = 368;
/// A `quote_tokens` entry with a 64-byte token id. Measured 110.
pub const QUOTE_ENTRY_BYTES: u64 = 112;
/// Token state besides its code and metadata strings: contract state, metadata
/// record and the owner's registration. Measured from the real token's `new`
/// with a 64-byte owner: 269 bytes without an icon, 273 with one
/// (`tests::costs::token_deploy_balance_covers_the_token`).
pub const TOKEN_STATE_BASE_BYTES: u64 = 280;
/// Extra bytes sent with the token deploy. Kept small: the token account can
/// never give NEAR back.
pub const TOKEN_STATE_MARGIN_BYTES: u64 = 200;

/// `bytes` plus the margin, in yoctoNEAR.
pub const fn storage_cost(bytes: u64) -> u128 {
    (bytes as u128 * (100 + STORAGE_MARGIN_PERCENT)).div_ceil(100) * YOCTO_PER_BYTE
}

/// NEAR for the sale's own records, given the lengths of its strings.
pub fn sale_storage_cost(sale_id_len: usize, accounts_len: usize, meta_len: usize) -> u128 {
    let bytes = SALE_BASE_BYTES
        + SALE_ID_COPIES * sale_id_len as u64
        + accounts_len as u64
        + meta_len as u64;
    storage_cost(bytes)
}

/// Prepaid per bid slot: its storage plus the winner's registration on the token.
pub const fn per_bid_reserve(mode: RevealMode) -> u128 {
    let bytes = match mode {
        RevealMode::Tee => BID_BYTES_TEE,
        RevealMode::CommitReveal => BID_BYTES_COMMIT_REVEAL,
    };
    storage_cost(bytes) + TOKEN_STORAGE_DEPOSIT
}

/// NEAR sent to the new token account: its code, account record and state.
/// `metadata_len` is name + symbol + icon bytes.
pub fn token_deploy_balance(metadata_len: usize) -> u128 {
    let bytes = TOKEN_WASM.len() as u64
        + ACCOUNT_RECORD_BYTES
        + TOKEN_STATE_BASE_BYTES
        + TOKEN_STATE_MARGIN_BYTES
        + metadata_len as u64;
    bytes as u128 * YOCTO_PER_BYTE
}

/// First sale with a quote token: this contract's registration on it plus the
/// `quote_tokens` entry.
pub const QUOTE_REGISTRATION_COST: u128 = TOKEN_STORAGE_DEPOSIT + storage_cost(QUOTE_ENTRY_BYTES);

// Launch liquidity on the Rhea (Ref) exchange, v1.9.x. Every sale with
// liquidity pays its own storage there; what the exchange or a token refunds
// (an excess over what it charges, or a registration that already existed)
// stays in this contract.
/// This contract's account on the exchange: the account record (102 bytes,
/// `storage_balance_bounds().min`) plus one token entry (148 bytes) for each
/// of the sale token and the quote token. Measured in the sandbox
/// (`contracts/tests`, `liquidity::exchange_storage_matches_the_constants`).
pub const DEX_ACCOUNT_BYTES: u64 = 398;
pub const DEX_ACCOUNT_DEPOSIT: u128 = DEX_ACCOUNT_BYTES as u128 * YOCTO_PER_BYTE;
/// Attached to `add_simple_pool`, which charges the pool record's storage
/// and refunds the rest. Measured 602 bytes with 64-byte token ids (the
/// longest) and a 32-byte exchange id; 700 leaves room for a longer exchange
/// id or a slightly larger record in a later exchange version.
pub const POOL_STORAGE_DEPOSIT: u128 = 7_000_000_000_000_000_000_000;
/// Attached to `add_liquidity`, which charges for this contract's LP share
/// record and refunds the rest. Measured 129 bytes with a 64-byte account id
/// (the longest); 160 with room to spare.
pub const LP_STORAGE_DEPOSIT: u128 = 1_600_000_000_000_000_000_000;
/// 1 yoctoNEAR each for `register_tokens`, the two deposits
/// (`ft_transfer_call`) and the two withdrawals. A failed call gets its
/// yoctoNEAR back; a withdrawal whose transfer failed inside the exchange
/// keeps it, and a retry of that costs this contract one more.
pub const LIQUIDITY_YOCTO: u128 = 5;
/// NEAR `create_sale` adds for launch liquidity besides the record's
/// storage: the exchange account, the exchange's registrations on both
/// tokens, the pool and the LP record. What no step spends is returned by
/// `claim_proceeds`.
pub const LIQUIDITY_NEAR_RESERVE: u128 = DEX_ACCOUNT_DEPOSIT
    + 2 * TOKEN_STORAGE_DEPOSIT
    + POOL_STORAGE_DEPOSIT
    + LP_STORAGE_DEPOSIT
    + LIQUIDITY_YOCTO;
/// A sale's liquidity record at its largest. Measured 165 bytes by
/// `tests::costs::liquidity_record_fits_the_constant`.
pub const LIQUIDITY_RECORD_BYTES: u64 = 168;

// OutLayer pricing, live `get_pricing` on outlayer.testnet and outlayer.near
// (9 Nov 2026). The owner can change it, so the deposit doubles the estimate;
// OutLayer refunds everything it does not charge to `payer_account_id`.
pub const OUTLAYER_BASE_FEE: u128 = 1_000_000_000_000_000_000_000;
pub const OUTLAYER_PER_MILLION_INSTRUCTIONS_FEE: u128 = 100_000_000_000_000;
pub const OUTLAYER_PER_MS_FEE: u128 = 100_000_000_000_000_000;
/// Input bytes OutLayer stores for free; each byte above holds 1e19 yoctoNEAR
/// until the request ends (then it goes back to the payer).
pub const OUTLAYER_FREE_INPUT_BYTES: usize = 32_768;
/// Fuel limit for a sealer run. Opening 500 sealed boxes can pass OutLayer's
/// default of 1e9 instructions; 5e10 costs 0.000005 NEAR at the live price.
pub const SEALER_MAX_INSTRUCTIONS: u64 = 50_000_000_000;
/// Well inside the 200-block (about 117 s) yield window.
pub const SEALER_MAX_EXECUTION_SECONDS: u64 = 60;
/// Memory limit for a sealer run (MB). OutLayer's testnet scheduler never
/// picks up a request that leaves `max_memory_mb` out: it times out after
/// 200 blocks with no run (seen 12 Nov 2026 with the job alone, with and
/// without secrets). 128 is OutLayer's default; a 500-bid clear uses about
/// 2.3 MiB, and the worker gives every run at least its memory floor anyway.
/// No memory fee is charged.
pub const SEALER_MAX_MEMORY_MB: u32 = 128;

/// Deposit for one OutLayer run (compute part only), with a 2x margin.
pub const OUTLAYER_COMPUTE_DEPOSIT: u128 = 2
    * (OUTLAYER_BASE_FEE
        + (SEALER_MAX_INSTRUCTIONS as u128 / 1_000_000) * OUTLAYER_PER_MILLION_INSTRUCTIONS_FEE
        + SEALER_MAX_EXECUTION_SECONDS as u128 * 1_000 * OUTLAYER_PER_MS_FEE);

/// Deposit `close_sale` requires for an input of `input_len` bytes.
pub fn close_deposit(input_len: usize) -> u128 {
    OUTLAYER_COMPUTE_DEPOSIT
        + input_len.saturating_sub(OUTLAYER_FREE_INPUT_BYTES) as u128 * YOCTO_PER_BYTE
}

// Gas.
/// Token `new`: registers the owner, mints, stores metadata.
pub const TOKEN_INIT_GAS: Gas = Gas::from_tgas(20);
/// Our fee for the token batch: create_account + transfer + deploy (send and
/// exec fees are both charged to the creating call) + the call's base fees.
pub const fn token_deploy_actions_gas() -> Gas {
    // deploy_contract_cost_per_byte: send 47.68 MGas + exec 64.57 MGas.
    Gas::from_gas(TOKEN_WASM.len() as u64 * 112_250_000 + Gas::from_tgas(10).as_gas())
}
pub const ON_TOKEN_DEPLOYED_GAS: Gas = Gas::from_tgas(10);
/// request_execution's fixed work plus the 50 TGas OutLayer reserves for its
/// callback. Unused gas of the call also goes to it (weight 1).
pub const OUTLAYER_REQUEST_BASE_GAS: Gas = Gas::from_tgas(60);
pub const ON_SEALER_KEY_GAS: Gas = Gas::from_tgas(10);
/// Settlement callback: parse the fills, check them, store one value.
/// Measured: 4.7 TGas for 100 and 12.3 TGas for 500 worst-case bids (a
/// 30.8 KB output); the largest possible output (39-digit amounts, about
/// 43 KB) extrapolates to 16 TGas. Running out would leave the sale in
/// `clearing` until refund mode, so this keeps almost 2x on top.
pub const ON_CLEARING_RESULT_GAS: Gas = Gas::from_tgas(30);
pub const STORAGE_DEPOSIT_GAS: Gas = Gas::from_tgas(10);
pub const FT_TRANSFER_GAS: Gas = Gas::from_tgas(10);
pub const BURN_GAS: Gas = Gas::from_tgas(10);
pub const ON_CLAIM_GAS: Gas = Gas::from_tgas(10);
pub const ON_PROCEEDS_GAS: Gas = Gas::from_tgas(10);
pub const ON_QUOTE_REGISTERED_GAS: Gas = Gas::from_tgas(5);
// Launch liquidity calls (the exchange and the tokens). Measured in the
// sandbox against the exchange's testnet wasm (v1.9.19): every call burnt
// 6 TGas or less; see contracts/GAS.md. The margins allow for a larger state
// on testnet and mainnet. Each step fits a relayed call (150 TGas).
/// The exchange's `storage_deposit` (with `register_tokens`: 5.5 TGas for both).
pub const DEX_STORAGE_DEPOSIT_GAS: Gas = Gas::from_tgas(10);
/// The exchange's `register_tokens`.
pub const DEX_REGISTER_TOKENS_GAS: Gas = Gas::from_tgas(10);
/// The exchange's `add_simple_pool` (2.8 TGas).
pub const ADD_SIMPLE_POOL_GAS: Gas = Gas::from_tgas(20);
/// A token's `ft_transfer_call` to the exchange: the token's work, the
/// exchange's `ft_on_transfer` and the token's `ft_resolve_transfer` (6.8
/// TGas in all). The NEP-141 reference keeps 30 TGas for itself and gives the
/// rest to the receiver.
pub const FT_TRANSFER_CALL_GAS: Gas = Gas::from_tgas(50);
/// The exchange's `add_liquidity` (4.0 TGas).
pub const ADD_LIQUIDITY_GAS: Gas = Gas::from_tgas(20);
/// The exchange's `withdraw`: its own work (3.5 TGas) and the 20 TGas each it
/// attaches to the `ft_transfer` and to its callback.
pub const DEX_WITHDRAW_GAS: Gas = Gas::from_tgas(50);
/// One of the exchange's small views (`get_number_of_pools`, `get_deposits`,
/// `get_pool_shares`) called as a function.
pub const DEX_VIEW_GAS: Gas = Gas::from_tgas(10);
/// The exchange's `get_pools` for `POOL_SCAN_LIMIT` (20) pools, read when a
/// pool's creation result was lost.
pub const DEX_POOL_SCAN_GAS: Gas = Gas::from_tgas(30);
/// A liquidity step's callback (3.3 TGas at most), before it starts the next
/// step (which it does with the call's unused gas, not with this).
pub const ON_LIQUIDITY_GAS: Gas = Gas::from_tgas(15);
/// `on_pool_count`, the pool step's first callback: its own work, the
/// `add_simple_pool` it sends and that call's callback.
pub const ON_POOL_COUNT_GAS: Gas = Gas::from_gas(
    ON_LIQUIDITY_GAS.as_gas() + ADD_SIMPLE_POOL_GAS.as_gas() + ON_LIQUIDITY_GAS.as_gas(),
);
/// Room for the rest of the calling method after its gas check (events, state
/// write, sending small promises). `close_sale` measured 2.4 TGas besides
/// `request_send_gas`.
pub const OWN_WORK_GAS: Gas = Gas::from_tgas(15);

/// Gas for `request_execution` with an input of `input_len` bytes: the base,
/// plus 25 MGas/byte above 32 KB that OutLayer adds to its callback reserve,
/// plus 75 MGas/byte for OutLayer to parse and store the input (measured:
/// request_execution burnt 22.0 TGas for a 262,330-byte input, and OutLayer's
/// callback 14.2 TGas of the 55.7 TGas it reserves).
pub fn outlayer_request_gas(input_len: usize) -> Gas {
    let over = input_len.saturating_sub(OUTLAYER_FREE_INPUT_BYTES) as u64;
    let per_byte = input_len as u64 * 75_000_000 + over * 25_000_000;
    Gas::from_gas(OUTLAYER_REQUEST_BASE_GAS.as_gas() + per_byte)
}

// Protocol fees per byte of function call arguments (protocol 88, read from
// the sandbox's `EXPERIMENTAL_protocol_config`). They change only with a
// protocol upgrade; `close_sale`'s gas check depends on them.
/// `action_function_call_per_byte.send_not_sir`: sending to another account.
pub const FUNCTION_CALL_SEND_PER_BYTE: u64 = 47_683_715;
/// `action_function_call_per_byte.execution`, prepaid by the sender.
pub const FUNCTION_CALL_EXEC_PER_BYTE: u64 = 2_235_934;
/// `read_memory_byte`: the host reads the arguments out of wasm memory.
pub const READ_MEMORY_BYTE: u64 = 3_801_333;

/// Gas per byte of `request_execution` arguments that `close_sale` uses after
/// its gas check, when the call is sent: the three fees above (53.72 MGas,
/// which is what an earlier build measured: 23.3 TGas for 394 KB) plus 12 %.
pub const REQUEST_SEND_GAS_PER_BYTE: u64 =
    (FUNCTION_CALL_SEND_PER_BYTE + FUNCTION_CALL_EXEC_PER_BYTE + READ_MEMORY_BYTE) * 112 / 100;

/// Gas `close_sale` burns sending `request_execution` arguments of
/// `args_len` bytes.
pub const fn request_send_gas(args_len: usize) -> Gas {
    Gas::from_gas(args_len as u64 * REQUEST_SEND_GAS_PER_BYTE)
}
