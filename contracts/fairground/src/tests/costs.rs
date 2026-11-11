//! Storage measurements behind the constants in `costs.rs`. Each test measures
//! the storage the real code paths write at their largest (records counted as
//! NEAR does: key + value + 40 bytes) and fails if a constant no longer covers
//! them. Run with `--nocapture` to see
//! the measured numbers.

use fairground_clearing::hash::commitment;
use near_contract_standards::fungible_token::metadata::FungibleTokenMetadata;
use near_sdk::env;

use super::settlement::{TestBid, resolve, sealer_output};
use super::*;
use crate::costs::{
    ACCOUNT_RECORD_BYTES, BID_BYTES_COMMIT_REVEAL, BID_BYTES_TEE, MAX_CIPHERTEXT_BYTES,
    QUOTE_ENTRY_BYTES, SALE_BASE_BYTES, SALE_ID_COPIES, TOKEN_STATE_BASE_BYTES,
    TOKEN_STATE_MARGIN_BYTES, TOKEN_WASM, YOCTO_PER_BYTE, token_deploy_balance,
};
use crate::{StepState, settle::MAX_STORED_CHECKS};

/// A 64-character account id (the longest possible).
fn long_account(c: char) -> AccountId {
    account(&format!("{}.testnet", c.to_string().repeat(56)))
}

/// Flushes the contract's caches and returns the storage in use.
fn usage(contract: &mut Fairground) -> u64 {
    contract.flush();
    storage_bytes()
}

/// Storage of one bid with the longest bidder id and payload, as the second
/// bid of a sale (the first one also creates the sale's deposits value). The
/// sale id is the longest too, so the TEE ciphertext is the longest a bid can
/// have (`MAX_CIPHERTEXT_BYTES`).
fn measured_bid_bytes(mode: RevealMode) -> u64 {
    let sale_id = "s".repeat(32);
    let sale_id = sale_id.as_str();
    let mut contract = ready_sale(sale_id, mode);
    let first = match mode {
        RevealMode::Tee => tee_msg(sale_id, &bid_ciphertext(0, sale_id, &bidder(0))),
        RevealMode::CommitReveal => commit_msg(sale_id, &[0; 32]),
    };
    assert_eq!(
        deliver(&mut contract, &usdc(), BID_START, &bidder(0), USDC, &first),
        0
    );
    let before = usage(&mut contract);
    let who = long_account('b');
    let salt = [5u8; 16];
    let msg = match mode {
        RevealMode::Tee => {
            assert_eq!(sealed_len(sale_id, &who), MAX_CIPHERTEXT_BYTES);
            tee_msg(sale_id, &ciphertext(1, MAX_CIPHERTEXT_BYTES))
        }
        RevealMode::CommitReveal => commit_msg(
            sale_id,
            &commitment(sale_id, who.as_str(), u128::MAX, u128::MAX, &salt),
        ),
    };
    assert_eq!(
        deliver(&mut contract, &usdc(), BID_START, &who, USDC, &msg),
        0
    );
    let mut bytes = usage(&mut contract) - before;
    if mode == RevealMode::CommitReveal {
        set_call(&who, BID_END, 0);
        contract.close_sale(sale_id.into()).unwrap().detach();
        let before = usage(&mut contract);
        set_call(&who, BID_END, 0);
        contract
            .reveal_bid(
                sale_id.into(),
                U128(u128::MAX),
                U128(u128::MAX),
                fairground_clearing::hash::to_hex(&salt),
            )
            .unwrap();
        bytes += usage(&mut contract) - before;
    }
    // Its settled fill, one (u128, u128) in the sale's fills value, and, if
    // it is invalid, its index (a u32) in the sale's invalid-bid list.
    bytes + 32 + 4
}

#[test]
fn bid_storage_fits_the_constants() {
    let tee = measured_bid_bytes(RevealMode::Tee);
    let commit_reveal = measured_bid_bytes(RevealMode::CommitReveal);
    println!("measured bytes per bid: tee {tee}, commit-reveal {commit_reveal}");
    assert!(
        tee <= BID_BYTES_TEE,
        "BID_BYTES_TEE {BID_BYTES_TEE} < measured {tee}"
    );
    assert!(
        commit_reveal <= BID_BYTES_COMMIT_REVEAL,
        "BID_BYTES_COMMIT_REVEAL {BID_BYTES_COMMIT_REVEAL} < measured {commit_reveal}"
    );
    // The constants are measurements, not guesses: at most 32 bytes of slack.
    assert!(BID_BYTES_TEE - tee <= 32 && BID_BYTES_COMMIT_REVEAL - commit_reveal <= 32);
}

#[test]
fn quote_entry_fits_the_constant() {
    let mut contract = new_contract();
    let before = usage(&mut contract);
    contract
        .quote_tokens
        .insert(long_account('q'), StepState::Pending);
    let bytes = usage(&mut contract) - before;
    println!("measured quote entry bytes: {bytes}");
    assert!(bytes <= QUOTE_ENTRY_BYTES && QUOTE_ENTRY_BYTES - bytes <= 16);
}

/// Params with every string at its longest and a 64-character creator.
fn longest_params(sale_id: &str, max_bids: u32) -> CreateSaleParams {
    let mut p = params(sale_id, RevealMode::Tee);
    p.token_name = "n".repeat(64);
    p.token_symbol = "S".repeat(16);
    p.icon = Some(format!("data:{}", "i".repeat(2043)));
    p.description = Some("d".repeat(280));
    p.website = Some("w".repeat(200));
    p.max_bids = max_bids;
    p
}

/// The sale's own storage at its largest: created by a 64-character account,
/// set up, closed and cleared, minus what its bids take. `tamper` turns the
/// correct sealer output into the one delivered.
fn measured_sale_bytes(bids: &[TestBid], tamper: impl Fn(&mut Value)) -> (u64, u64) {
    let sale_id = "s".repeat(32);
    let mut contract = new_contract();
    // Another sale registers the quote token first.
    create(&mut contract, params("first", RevealMode::Tee));
    let p = longest_params(&sale_id, bids.len() as u32);
    let creator = long_account('c');
    let before = usage(&mut contract);
    set_call(&creator, T0, 0);
    let cost = contract.get_create_cost(p.clone()).unwrap().0;
    set_call(&creator, T0, cost);
    contract.create_sale(p.clone()).unwrap();
    finish_setup(&mut contract, &sale_id, RevealMode::Tee);
    let mut deltas = Vec::with_capacity(bids.len());
    for bid in bids {
        let start = usage(&mut contract);
        place_tee_bid(&mut contract, &sale_id, bid.n, bid.deposit);
        deltas.push(usage(&mut contract) - start);
    }
    // Bids 0 and 1 have the same size; the first also created the sale's
    // deposits value, which belongs to the sale.
    let deposits_value = deltas[0] - deltas[1];
    let bid_bytes: u64 = deltas.iter().sum::<u64>() - deposits_value;
    set_call(&account("closer.testnet"), BID_END, 0);
    let deposit = contract.get_close_deposit(sale_id.clone()).unwrap().0;
    set_call(&account("closer.testnet"), BID_END, deposit);
    contract.close_sale(sale_id.clone()).unwrap().detach();
    let mut output = sealer_output(&contract, &p, bids);
    tamper(&mut output);
    resolve(
        &mut contract,
        &sale_id,
        deposit,
        PromiseResult::Successful(text_output(&output.to_string())),
    );
    let total = usage(&mut contract) - before;
    let result = contract.get_result(sale_id.clone()).unwrap();
    let fills = match result.status {
        crate::Status::Settled => 32 * bids.len() as u64,
        _ => 0,
    };
    // The per-bid part of the invalid-bid list; its record belongs to the sale.
    let invalid = if result.total_penalties.0 > 0 {
        4 * u64::from(result.n_invalid)
    } else {
        0
    };
    let sale_bytes = total - bid_bytes - fills - invalid;
    let accounts = creator.len() + usdc().len() + format!("{sale_id}.fairground.testnet").len();
    let meta = 64 + 16 + 2048 + 280 + 200;
    let formula = SALE_BASE_BYTES + SALE_ID_COPIES * sale_id.len() as u64 + accounts as u64 + meta;
    (sale_bytes, formula)
}

#[test]
fn sale_storage_fits_the_formula() {
    // Settled: the fills value exists.
    let bids: Vec<TestBid> = (0..3)
        .map(|n| TestBid {
            n,
            deposit: 100 * USDC,
            price: 2_000,
            spend: 100 * USDC,
        })
        .collect();
    let (settled, formula) = measured_sale_bytes(&bids, |_| {});
    // Failed with the longest check names stored: indices of three digits.
    let bids: Vec<TestBid> = (0..110)
        .map(|n| TestBid {
            n,
            deposit: 10 * USDC,
            price: 2_000,
            spend: 10 * USDC,
        })
        .collect();
    let (failed, _) = measured_sale_bytes(&bids, |output| {
        for i in 100..110 {
            output["fills"][i][1] = json!("0");
        }
    });
    // Settled with invalid bids: the invalid-bid list exists too.
    let bids: Vec<TestBid> = (0..4)
        .map(|n| TestBid {
            n,
            deposit: 100 * USDC,
            price: if n < 2 { 2_000 } else { 999 },
            spend: 100 * USDC,
        })
        .collect();
    let (penalized, _) = measured_sale_bytes(&bids, |_| {});
    println!(
        "measured sale bytes: settled {settled}, failed {failed}, settled with invalid bids {penalized}; formula {formula}"
    );
    let largest = settled.max(failed).max(penalized);
    assert!(
        largest <= formula,
        "SALE_BASE_BYTES too small: {largest} > {formula}"
    );
    assert!(
        formula - largest <= 64,
        "SALE_BASE_BYTES has more than 64 bytes of slack"
    );
    assert_eq!(MAX_STORED_CHECKS, 8);
}

#[test]
fn token_deploy_balance_covers_the_token() {
    // The real token's `new`, writing its state as the deployed contract would.
    for (name, symbol, icon) in [
        ("T", "T", None),
        (
            "Fair Test",
            "FAIRT",
            Some("data:image/svg+xml,<svg/>".to_owned()),
        ),
        (
            &*"n".repeat(64),
            &*"S".repeat(16),
            Some(format!("data:{}", "i".repeat(2043))),
        ),
    ] {
        // Empty storage: the token account starts with none.
        with_mocked_blockchain(|chain| chain.take_storage());
        let before = storage_bytes();
        let metadata = FungibleTokenMetadata {
            spec: "ft-1.0.0".to_owned(),
            name: name.to_owned(),
            symbol: symbol.to_owned(),
            icon: icon.clone(),
            reference: None,
            reference_hash: None,
            decimals: 24,
        };
        let token =
            fairground_token::FairgroundToken::new(long_account('f'), U128(u128::MAX), metadata);
        env::state_write(&token);
        drop(token);
        let state = storage_bytes() - before;
        let metadata_len = name.len() + symbol.len() + icon.as_ref().map_or(0, String::len);
        let needed = TOKEN_WASM.len() as u64 + ACCOUNT_RECORD_BYTES + state;
        let sent = token_deploy_balance(metadata_len);
        println!(
            "token state {state} bytes (metadata {metadata_len}); account needs {needed} bytes"
        );
        assert!(
            sent >= u128::from(needed) * YOCTO_PER_BYTE,
            "token deploy balance too small"
        );
        assert!(state <= TOKEN_STATE_BASE_BYTES + metadata_len as u64);
        assert!(
            sent - u128::from(needed) * YOCTO_PER_BYTE
                <= u128::from(TOKEN_STATE_MARGIN_BYTES + 64) * YOCTO_PER_BYTE
        );
    }
}

/// The figures DESIGN and GAS.md quote, so a change of a price, a limit or an
/// id length shows up here first.
#[test]
fn quoted_figures_match_the_constants() {
    use crate::costs::{OUTLAYER_COMPUTE_DEPOSIT, close_deposit, per_bid_reserve};

    // Twice OutLayer's estimate of 0.007005 NEAR: 0.01401 NEAR.
    assert_eq!(OUTLAYER_COMPUTE_DEPOSIT, 14_010_000_000_000_000_000_000);
    assert_eq!(close_deposit(32_768), OUTLAYER_COMPUTE_DEPOSIT);
    assert_eq!(
        close_deposit(32_769),
        OUTLAYER_COMPUTE_DEPOSIT + YOCTO_PER_BYTE
    );
    // The longest sealed bid: 224 + a 32-byte sale id + a 64-byte bidder.
    assert_eq!(MAX_CIPHERTEXT_BYTES, 320);
    // 624 x 1.15 bytes (rounded up to 718) + 0.00125 NEAR; 368 x 1.15 (424).
    assert_eq!(
        per_bid_reserve(RevealMode::Tee),
        8_430_000_000_000_000_000_000
    );
    assert_eq!(
        per_bid_reserve(RevealMode::CommitReveal),
        5_490_000_000_000_000_000_000
    );
}
