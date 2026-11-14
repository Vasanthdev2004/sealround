use near_sdk::serde_json;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};

use super::*;

const START: u64 = 100;
const COMMIT_END: u64 = 200;
const REVEAL_END: u64 = 300;
const SALT: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const CONTRACT: &str = "chapters.test.near";
const CURATOR: &str = "curator.test.near";
const TOKEN: &str = "lantern.test.near";
const QUOTE: &str = "usdc.test.near";
const SPONSOR: &str = "sponsor.test.near";
const ARTISTS: [&str; 2] = ["mira.test.near", "sol.test.near"];
const VOTERS: [&str; 2] = ["alice.test.near", "bob.test.near"];

fn id(account: &str) -> AccountId {
    account.parse().unwrap()
}

fn context(account: &str, now: u64, deposit: u128) -> VMContextBuilder {
    let mut c = VMContextBuilder::new();
    c.current_account_id(id(CONTRACT))
        .predecessor_account_id(id(account))
        .signer_account_id(id(account))
        .block_timestamp(now)
        .account_balance(NearToken::from_near(100))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(100));
    c
}

fn actor(account: &str, now: u64, deposit: u128) {
    testing_env!(context(account, now, deposit).build());
}

fn callback(result: PromiseResult) {
    testing_env!(
        context(CONTRACT, REVEAL_END, 0).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
}

fn create(chapters: &mut Chapters, now: u64, max_voters: u16) -> u32 {
    create_with_art(
        chapters,
        now,
        max_voters,
        ARTISTS.map(|artist| Candidate {
            title: format!("Panel by {artist}"),
            content_sha256: if artist == ARTISTS[0] { "ab" } else { "cd" }.repeat(32),
            artist: id(artist),
        }),
        None,
    )
}

fn create_with_art(
    chapters: &mut Chapters,
    now: u64,
    max_voters: u16,
    candidates: [Candidate; 2],
    submission_ids: Option<[u32; 2]>,
) -> u32 {
    let cost = chapters.storage_cost(max_voters).0;
    actor(CURATOR, now, cost);
    chapters.create_round(
        "Lantern's story".to_owned(),
        candidates,
        id(SPONSOR),
        U128(10_000_000),
        U128(10),
        max_voters,
        U64(now + START),
        U64(now + COMMIT_END),
        U64(now + REVEAL_END),
        submission_ids,
    )
}

fn setup() -> Chapters {
    actor(CONTRACT, 0, 0);
    let mut chapters = Chapters::new(id(CURATOR), id(TOKEN), id(QUOTE));
    assert_eq!(create(&mut chapters, 0, 2), 1);
    chapters
}

#[test]
#[should_panic(expected = "Only the immediate parent")]
fn factory_initialization_requires_the_immediate_parent() {
    actor(CURATOR, 0, 0);
    Chapters::new_from_factory(id(CURATOR), id(TOKEN), id(QUOTE));
}

#[test]
#[should_panic(expected = "Choose two signed artist submissions")]
fn factory_chapters_require_signed_art_entries() {
    actor("test.near", 0, 0);
    let mut chapters = Chapters::new_from_factory(id(CURATOR), id(TOKEN), id(QUOTE));
    create(&mut chapters, 0, 2);
}

fn transfer(
    chapters: &mut Chapters,
    token: &str,
    sender: &str,
    time: u64,
    amount: u128,
    msg: Value,
) -> u128 {
    actor(token, time, 0);
    match chapters.ft_on_transfer(id(sender), U128(amount), msg.to_string()) {
        PromiseOrValue::Value(unused) => unused.0,
        PromiseOrValue::Promise(_) => panic!("Escrow receiver sent a promise"),
    }
}

fn fund(chapters: &mut Chapters) {
    assert_eq!(
        transfer(
            chapters,
            QUOTE,
            SPONSOR,
            START - 1,
            10_000_000,
            json!({
                "kind": "fund", "round_id": 1,
            })
        ),
        0
    );
}

fn commit(chapters: &mut Chapters, sender: &str, amount: u128, choice: u8) -> u128 {
    let sealed = hex(&commitment(&id(CONTRACT), 1, &id(sender), choice, SALT));
    transfer(
        chapters,
        TOKEN,
        sender,
        START,
        amount,
        json!({
            "kind": "commit", "round_id": 1, "commitment": sealed,
        }),
    )
}

#[test]
fn refunds_rejected_transfers_and_never_double_counts_a_lock() {
    let mut chapters = setup();
    let funding = json!({ "kind": "fund", "round_id": 1 });
    assert_eq!(
        transfer(
            &mut chapters,
            QUOTE,
            "other.test.near",
            1,
            10_000_000,
            funding.clone()
        ),
        10_000_000
    );
    assert_eq!(
        transfer(
            &mut chapters,
            TOKEN,
            SPONSOR,
            1,
            10_000_000,
            funding.clone()
        ),
        10_000_000
    );
    assert_eq!(
        transfer(&mut chapters, QUOTE, SPONSOR, 1, 9_000_000, funding.clone()),
        9_000_000
    );
    fund(&mut chapters);
    assert_eq!(
        transfer(&mut chapters, QUOTE, SPONSOR, 1, 10_000_000, funding),
        10_000_000
    );
    assert_eq!(commit(&mut chapters, VOTERS[0], 12, 0), 0);
    assert_eq!(commit(&mut chapters, VOTERS[0], 99, 0), 99);
    assert_eq!(commit(&mut chapters, VOTERS[1], 8, 1), 0);
    assert_eq!(commit(&mut chapters, "voter3.test.near", 100, 0), 100);
    let round = chapters.get_round(1).unwrap();
    assert_eq!(round.committed_count, 2);
    assert_eq!(round.locked.0, 20);
    assert_eq!(round.tallies.map(|amount| amount.0), [0, 0]);
}

#[test]
fn winner_and_nonrevealing_holder_can_claim_while_later_rounds_run() {
    let mut chapters = setup();
    assert!(chapters.get_payout(1).is_none());
    fund(&mut chapters);
    assert_eq!(commit(&mut chapters, VOTERS[0], 12, 0), 0);
    assert_eq!(commit(&mut chapters, VOTERS[1], 30, 1), 0);
    actor(VOTERS[0], COMMIT_END, 0);
    chapters.reveal(1, 0, SALT.to_owned());
    actor("reader.test.near", REVEAL_END, 0);
    let round = chapters.finalize(1);
    assert_eq!(round.outcome, Some(Outcome::Winner));
    assert_eq!(round.winner, Some(0));
    assert_eq!(round.tallies.map(|amount| amount.0), [12, 0]);
    assert_eq!(create(&mut chapters, REVEAL_END + 1, 2), 2);
    let second = chapters.get_round(2).unwrap();
    assert_eq!(second.terms.submission_ids, None);
    assert_eq!(second.terms.parent_sha256, Some("ab".repeat(32)));

    actor(VOTERS[1], REVEAL_END + 2, 1);
    drop(chapters.withdraw_vote(1));
    assert_eq!(
        chapters
            .get_vote(1, id(VOTERS[1]))
            .unwrap()
            .withdrawal_state,
        PaymentState::Pending
    );
    callback(PromiseResult::Successful(Vec::new()));
    assert!(chapters.on_withdraw_vote(1, id(VOTERS[1]), 1));
    assert_eq!(
        chapters
            .get_vote(1, id(VOTERS[1]))
            .unwrap()
            .withdrawal_state,
        PaymentState::Paid
    );

    actor(ARTISTS[0], REVEAL_END + 2, 1);
    drop(chapters.claim_bounty(1));
    let pending = chapters.get_payout(1).unwrap();
    assert_eq!(pending.state, PaymentState::Pending);
    assert_eq!(pending.paid_at, None);
    assert_eq!(pending.attempt, 1);
    callback(PromiseResult::Successful(Vec::new()));
    assert!(chapters.on_claim_bounty(1, 1));
    assert_eq!(
        serde_json::to_value(chapters.get_payout(1)).unwrap(),
        json!({
            "recipient": ARTISTS[0], "token_id": QUOTE, "amount": "10000000",
            "state": "paid", "paid_at": REVEAL_END.to_string(), "attempt": 1,
        })
    );
    assert!(chapters.get_payout(2).is_none());
    assert_eq!(
        chapters.get_round(1).unwrap().bounty_state,
        PaymentState::Paid
    );
    assert_eq!(
        chapters.get_round(2).unwrap().bounty_state,
        PaymentState::Unclaimed
    );
}

#[test]
fn failed_transfer_allows_retry_but_an_old_callback_cannot_reopen_it() {
    let mut chapters = setup();
    fund(&mut chapters);
    actor("reader.test.near", REVEAL_END, 0);
    assert_eq!(chapters.finalize(1).outcome, Some(Outcome::NoQuorum));

    actor(SPONSOR, REVEAL_END, 1);
    drop(chapters.claim_bounty(1));
    callback(PromiseResult::Failed);
    assert!(!chapters.on_claim_bounty(1, 1));
    let retry = chapters.get_payout(1).unwrap();
    assert_eq!(retry.recipient, id(SPONSOR));
    assert_eq!(retry.state, PaymentState::Unclaimed);
    assert_eq!(retry.paid_at, None);
    assert_eq!(retry.attempt, 1);
    assert_eq!(
        chapters.get_round(1).unwrap().bounty_state,
        PaymentState::Unclaimed
    );

    actor(SPONSOR, REVEAL_END, 1);
    drop(chapters.claim_bounty(1));
    callback(PromiseResult::Successful(Vec::new()));
    assert!(!chapters.on_claim_bounty(1, 1));
    assert_eq!(chapters.get_payout(1).unwrap().paid_at, None);
    assert_eq!(
        chapters.get_round(1).unwrap().bounty_state,
        PaymentState::Pending
    );
    callback(PromiseResult::Successful(Vec::new()));
    assert!(chapters.on_claim_bounty(1, 2));
    let log = get_logs().pop().unwrap();
    let event: Value = serde_json::from_str(log.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    assert_eq!(
        event["data"],
        json!([{
            "round_id": 1, "attempt": 2, "account": SPONSOR, "amount": "10000000",
            "token_id": QUOTE, "paid": true, "paid_at": REVEAL_END.to_string(),
        }]),
    );

    callback(PromiseResult::Failed);
    assert!(!chapters.on_claim_bounty(1, 2));
    assert_eq!(
        chapters.get_payout(1).unwrap().paid_at,
        Some(U64(REVEAL_END))
    );
    assert_eq!(chapters.get_payout(1).unwrap().attempt, 2);
    assert_eq!(
        chapters.get_round(1).unwrap().bounty_state,
        PaymentState::Paid
    );
}

#[test]
fn caps_storage_and_serializes_public_base_units() {
    let mut chapters = setup();
    fund(&mut chapters);
    chapters.rounds.flush();
    let usage = env::storage_usage();
    let large_account = "a".repeat(64);
    assert_eq!(commit(&mut chapters, &large_account, 20, 0), 0);
    assert_eq!(commit(&mut chapters, VOTERS[1], 20, 1), 0);
    chapters.rounds.flush();
    chapters.votes.flush();
    chapters.vote_order.flush();
    let bytes = u128::from(env::storage_usage() - usage);
    assert!(bytes <= 2 * VOTE_BYTES);
    let json = serde_json::to_value(chapters.get_round(1).unwrap()).unwrap();
    assert_eq!(json["starts_at"], "100");
    assert_eq!(json["locked"], "40");
    assert_eq!(json["tallies"], json!(["0", "0"]));
    assert_eq!(json["bounty_state"], "unclaimed");
    assert_eq!(json["candidates"][0]["artist"], ARTISTS[0]);
    assert!(json.get("terms").is_none());
}

#[test]
fn unfunded_round_expires_without_opening_the_vote() {
    let mut chapters = setup();
    assert_eq!(commit(&mut chapters, VOTERS[0], 12, 0), 12);
    let round = chapters.finalize(1);
    assert_eq!(round.outcome, Some(Outcome::Unfunded));
    assert_eq!(round.bounty_state, PaymentState::Unclaimed);
    assert!(chapters.get_payout(1).is_none());
    assert!(
        chapters
            .rounds
            .get(&1)
            .unwrap()
            .bounty_recipient()
            .is_none()
    );
}

#[test]
fn public_votes_page_in_commit_order_and_only_show_revealed_choices() {
    actor(CONTRACT, 0, 0);
    let mut chapters = Chapters::new(id(CURATOR), id(TOKEN), id(QUOTE));
    create(&mut chapters, 0, MAX_VOTE_PAGE + 1);
    fund(&mut chapters);
    // Commit in descending account order so sorting by account would fail.
    for i in (0..=MAX_VOTE_PAGE).rev() {
        assert_eq!(
            commit(
                &mut chapters,
                &format!("voter-{i}.test.near"),
                u128::from(i) + 1,
                0
            ),
            0
        );
    }
    let first = chapters.get_votes(1, None, Some(u16::MAX));
    assert_eq!(first.len(), usize::from(MAX_VOTE_PAGE));
    assert_eq!(first[0].account_id, id("voter-64.test.near"));
    assert_eq!(first[0].vote.revealed_choice, None);
    assert_eq!(first[63].account_id, id("voter-1.test.near"));
    assert_eq!(
        chapters.get_votes(1, None, None).len(),
        usize::from(DEFAULT_VOTE_PAGE)
    );
    assert!(chapters.get_votes(1, None, Some(0)).is_empty());
    assert!(chapters.get_votes(1, Some(u16::MAX), None).is_empty());
    assert!(chapters.get_votes(999, None, None).is_empty());

    actor("voter-0.test.near", COMMIT_END, 0);
    chapters.reveal(1, 0, SALT.to_owned());
    let last = chapters.get_votes(1, Some(MAX_VOTE_PAGE), Some(5));
    assert_eq!(last.len(), 1);
    assert_eq!(
        serde_json::to_value(&last[0]).unwrap(),
        json!({
            "account_id": "voter-0.test.near", "amount": "1",
            "commitment": hex(&commitment(&id(CONTRACT), 1, &id("voter-0.test.near"), 0, SALT)),
            "revealed_choice": 0, "withdrawal_state": "unclaimed",
        })
    );
}

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

fn artwork(
    chapters: &mut Chapters,
    round_id: u32,
    artist: &str,
    mark: u8,
    parent: Option<&str>,
) -> ArtSubmission {
    let bytes = [PNG_SIGNATURE, &[mark]].concat();
    let deposit = chapters.art_storage_cost(bytes.len() as u32).0;
    actor(artist, if round_id == 1 { 0 } else { REVEAL_END }, deposit);
    chapters.submit_art(
        round_id,
        format!("Panel {mark}"),
        "image/png".to_owned(),
        BASE64.encode(bytes),
        parent.map(str::to_owned),
    )
}

fn empty() -> Chapters {
    actor(CONTRACT, 0, 0);
    Chapters::new(id(CURATOR), id(TOKEN), id(QUOTE))
}

fn finalize_with_winner(chapters: &mut Chapters) -> String {
    fund(chapters);
    assert_eq!(commit(chapters, VOTERS[0], 12, 0), 0);
    actor(VOTERS[0], COMMIT_END, 0);
    chapters.reveal(1, 0, SALT.to_owned());
    actor(VOTERS[0], REVEAL_END, 0);
    let first = chapters.finalize(1);
    assert_eq!(first.winner, Some(0));
    first.terms.candidates[0].content_sha256.clone()
}

#[test]
fn submitted_bytes_and_curator_selection_link_consecutive_winners() {
    let mut chapters = empty();
    let first = artwork(&mut chapters, 1, ARTISTS[0], 0, None);
    let second = artwork(&mut chapters, 1, ARTISTS[1], 1, None);
    assert_eq!([first.submission_id, second.submission_id], [1, 2]);
    let bytes = [PNG_SIGNATURE, &[0]].concat();
    assert_eq!(
        chapters.get_art(1, first.submission_id),
        Some(BASE64.encode(&bytes))
    );
    assert_eq!(chapters.get_art(2, first.submission_id), None);
    assert_eq!(
        serde_json::to_value(&chapters.get_submissions(1)[0]).unwrap(),
        json!({
            "round_id": 1, "submission_id": 1, "title": "Panel 0", "artist": ARTISTS[0],
            "content_sha256": hex(&env::sha256_array(&bytes)), "mime_type": "image/png", "parent_sha256": null,
        }),
    );
    assert_eq!(
        create_with_art(
            &mut chapters,
            0,
            2,
            [first.candidate, second.candidate],
            Some([1, 2])
        ),
        1
    );
    let winner = finalize_with_winner(&mut chapters);
    let replies = [
        artwork(&mut chapters, 2, ARTISTS[0], 2, Some(&winner)),
        artwork(&mut chapters, 2, ARTISTS[1], 3, Some(&winner)),
    ];
    assert_eq!(
        create_with_art(
            &mut chapters,
            REVEAL_END,
            2,
            replies.map(|reply| reply.candidate),
            Some([1, 2])
        ),
        2
    );
    let follow_up = chapters.get_round(2).unwrap();
    assert_eq!(follow_up.terms.submission_ids, Some([1, 2]));
    assert_eq!(
        follow_up.terms.parent_sha256.as_deref(),
        Some(winner.as_str())
    );
}

#[test]
#[should_panic(expected = "Artwork parent must match the previous winner")]
fn wrong_parent_is_rejected() {
    let mut chapters = setup();
    let winner = finalize_with_winner(&mut chapters);
    let wrong = "ff".repeat(32);
    assert_ne!(wrong, winner);
    artwork(&mut chapters, 2, ARTISTS[0], 0, Some(&wrong));
}

#[test]
#[should_panic(expected = "The previous round needs a winner")]
fn submissions_require_a_previous_winner() {
    let mut chapters = setup();
    actor(VOTERS[0], REVEAL_END, 0);
    assert_eq!(chapters.finalize(1).outcome, Some(Outcome::Unfunded));
    artwork(&mut chapters, 2, ARTISTS[0], 0, None);
}

#[test]
#[should_panic(expected = "This artist has already submitted")]
fn duplicate_artist_is_rejected() {
    let mut chapters = empty();
    artwork(&mut chapters, 1, ARTISTS[0], 0, None);
    artwork(&mut chapters, 1, ARTISTS[0], 1, None);
}

#[test]
#[should_panic(expected = "Choose from the submitted artwork")]
fn bundled_art_cannot_bypass_submissions() {
    let mut chapters = empty();
    artwork(&mut chapters, 1, ARTISTS[0], 0, None);
    create(&mut chapters, 0, 2);
}

#[test]
#[should_panic(expected = "Continue the story with submitted artwork")]
fn a_story_using_submissions_cannot_revert_to_bundled_art() {
    let mut chapters = empty();
    let first = artwork(&mut chapters, 1, ARTISTS[0], 0, None);
    let second = artwork(&mut chapters, 1, ARTISTS[1], 1, None);
    create_with_art(
        &mut chapters,
        0,
        2,
        [first.candidate, second.candidate],
        Some([1, 2]),
    );
    finalize_with_winner(&mut chapters);
    create(&mut chapters, REVEAL_END, 2);
}

#[test]
#[should_panic(expected = "Artwork must differ from the previous winner")]
fn winning_bytes_cannot_be_resubmitted_as_the_follow_up() {
    let mut chapters = empty();
    let first = artwork(&mut chapters, 1, ARTISTS[0], 0, None);
    let second = artwork(&mut chapters, 1, ARTISTS[1], 1, None);
    create_with_art(
        &mut chapters,
        0,
        2,
        [first.candidate, second.candidate],
        Some([1, 2]),
    );
    let winner = finalize_with_winner(&mut chapters);
    artwork(&mut chapters, 2, ARTISTS[1], 0, Some(&winner));
}

#[test]
#[should_panic(expected = "This artwork has already been submitted")]
fn duplicate_bytes_are_rejected_across_artists() {
    let mut chapters = empty();
    artwork(&mut chapters, 1, ARTISTS[0], 0, None);
    artwork(&mut chapters, 1, ARTISTS[1], 0, None);
}

#[test]
#[should_panic(expected = "Artwork exceeds 49152 bytes")]
fn over_limit_upload_is_rejected_before_decoding() {
    let mut chapters = empty();
    actor(ARTISTS[0], 0, 0);
    chapters.submit_art(
        1,
        "Oversized panel".to_owned(),
        "image/png".to_owned(),
        BASE64.encode(vec![0; MAX_ART_BYTES as usize + 1]),
        None,
    );
}

#[test]
#[should_panic(expected = "Attach the exact artwork storage cost")]
fn artist_must_prepay_storage() {
    let mut chapters = empty();
    actor(ARTISTS[0], 0, 0);
    chapters.submit_art(
        1,
        "Paid storage".to_owned(),
        "image/png".to_owned(),
        BASE64.encode(PNG_SIGNATURE),
        None,
    );
}

#[test]
#[should_panic(expected = "Candidates must match their artwork submissions")]
fn curator_cannot_replace_the_signed_artist_or_art_attributes() {
    let mut chapters = empty();
    let mut first = artwork(&mut chapters, 1, ARTISTS[0], 0, None);
    let second = artwork(&mut chapters, 1, ARTISTS[1], 1, None);
    first.candidate.artist = id(CURATOR);
    create_with_art(
        &mut chapters,
        0,
        2,
        [first.candidate, second.candidate],
        Some([1, 2]),
    );
}

#[test]
#[should_panic(expected = "Artwork must match its JPEG, PNG or WebP type")]
fn artwork_signature_must_match_the_claimed_type() {
    let mut chapters = empty();
    let cost = chapters.art_storage_cost(PNG_SIGNATURE.len() as u32).0;
    actor(ARTISTS[0], 0, cost);
    chapters.submit_art(
        1,
        "Wrong type".to_owned(),
        "image/webp".to_owned(),
        BASE64.encode(PNG_SIGNATURE),
        None,
    );
}

#[test]
#[should_panic(expected = "The artist must sign directly")]
fn delegated_submission_cannot_impersonate_an_artist() {
    let mut chapters = empty();
    let cost = chapters.art_storage_cost(PNG_SIGNATURE.len() as u32).0;
    testing_env!(
        context(ARTISTS[0], 0, cost)
            .signer_account_id(id(CURATOR))
            .build()
    );
    chapters.submit_art(
        1,
        "Wrong signer".to_owned(),
        "image/png".to_owned(),
        BASE64.encode(PNG_SIGNATURE),
        None,
    );
}

#[test]
#[should_panic(expected = "Artwork submission limit reached")]
fn bounds_per_round_submissions() {
    let mut chapters = empty();
    for i in 0..=MAX_SUBMISSIONS as u8 {
        artwork(&mut chapters, 1, &format!("artist-{i}.test.near"), i, None);
    }
}

#[test]
fn quoted_art_storage_covers_the_largest_entry() {
    let mut chapters = setup();
    let winner = finalize_with_winner(&mut chapters);
    let mut bytes = vec![0; MAX_ART_BYTES as usize];
    bytes[..PNG_SIGNATURE.len()].copy_from_slice(PNG_SIGNATURE);
    let cost = chapters.art_storage_cost(MAX_ART_BYTES).0;
    actor(&"a".repeat(64), REVEAL_END, cost);
    let usage = env::storage_usage();
    let art = chapters.submit_art(
        2,
        "a".repeat(MAX_TITLE_BYTES),
        "image/png".to_owned(),
        BASE64.encode(bytes),
        Some(winner),
    );
    chapters.art_submissions.flush();
    chapters.art_files.flush();
    let used_bytes = u128::from(env::storage_usage() - usage);
    assert!(used_bytes > u128::from(MAX_ART_BYTES));
    assert!(used_bytes * env::storage_byte_cost().as_yoctonear() <= cost);
    assert_eq!(
        chapters.get_art(2, art.submission_id).unwrap().len(),
        MAX_ART_BYTES as usize / 3 * 4
    );
}
