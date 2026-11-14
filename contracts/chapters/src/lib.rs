//! Optional post-launch rounds for a fixed NEP-141 token and quote asset.

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::base64::Engine as _;
use near_sdk::base64::engine::general_purpose::STANDARD as BASE64;
use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{Value, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue, assert_one_yocto, env, ext_contract, near, require,
};

const MAX_ROUNDS: u32 = 64;
const MAX_VOTERS: u16 = 512;
const DEFAULT_VOTE_PAGE: u16 = 32;
const MAX_VOTE_PAGE: u16 = 64;
const MAX_TITLE_BYTES: usize = 96;
const MAX_ROUND_NS: u64 = 90 * 24 * 60 * 60 * 1_000_000_000;
const MAX_ART_BYTES: u32 = 48 * 1024;
const MAX_SUBMISSIONS: usize = 8;
// Bounded JSON account IDs plus the key and trie overhead.
const ARTIST_ROSTER_BYTES: u128 = 768;
// Reserve room for the largest metadata and both storage keys along with the artwork.
const ART_OVERHEAD_BYTES: u128 = 512;
// Reserve enough for the round, its payout record and every indexed vote.
const ROUND_BYTES: u128 = 2_048;
const VOTE_BYTES: u128 = 512;
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(30);
const CALLBACK_GAS: Gas = Gas::from_tgas(15);
const REQUIRED_CLAIM_GAS: Gas = Gas::from_tgas(70);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const SUBMISSIONS_REQUIRED: &[u8] = b"factory:submissions-required";
const LAST_WINNER: &[u8] = b"story:last-winner";

#[ext_contract(ext_ft)]
#[allow(dead_code, reason = "the macro generates the outgoing transfer call")]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Rounds,
    Votes,
    VoteOrder,
    ArtSubmissions,
    ArtFiles,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Candidate {
    pub title: String,
    pub content_sha256: String,
    pub artist: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct ArtSubmission {
    submission_id: u32,
    round_id: u32,
    #[serde(flatten)]
    candidate: Candidate,
    mime_type: String,
    parent_sha256: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
struct RoundTerms {
    title: String,
    candidates: [Candidate; 2],
    submission_ids: Option<[u32; 2]>,
    parent_sha256: Option<String>,
    sponsor: AccountId,
    bounty: U128,
    quorum: U128,
    max_voters: u16,
    starts_at: U64,
    commit_end: U64,
    reveal_end: U64,
}

impl RoundTerms {
    fn min_lock(&self) -> u128 {
        self.quorum.0.div_ceil(u128::from(self.max_voters))
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum PaymentState {
    #[default]
    Unclaimed,
    Pending,
    Paid,
}

#[near(serializers = [borsh])]
#[derive(Default)]
struct Payment {
    state: PaymentState,
    attempt: u32,
}

impl Payment {
    fn start(&mut self) -> u32 {
        require!(
            self.state == PaymentState::Unclaimed,
            "Payment already pending or paid"
        );
        require!(
            env::prepaid_gas() >= REQUIRED_CLAIM_GAS,
            "Attach at least 70 TGas"
        );
        self.attempt = self
            .attempt
            .checked_add(1)
            .expect("Too many payment attempts");
        self.state = PaymentState::Pending;
        self.attempt
    }

    fn finish(&mut self, attempt: u32, paid: bool) -> bool {
        if self.state != PaymentState::Pending || self.attempt != attempt {
            return false;
        }
        self.state = if paid {
            PaymentState::Paid
        } else {
            PaymentState::Unclaimed
        };
        true
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    Winner,
    Tie,
    NoQuorum,
    Unfunded,
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Funding,
    Commit,
    Reveal,
    AwaitingFinalization,
    Finalized,
}

#[near(serializers = [borsh])]
struct Round {
    terms: RoundTerms,
    funded: bool,
    committed_count: u16,
    locked: u128,
    revealed: u128,
    tallies: [u128; 2],
    outcome: Option<Outcome>,
    winner: Option<u8>,
    payment: Payment,
    paid_bounty: Option<PaidBounty>,
}

impl Round {
    fn new(terms: RoundTerms) -> Self {
        Self {
            terms,
            funded: false,
            committed_count: 0,
            locked: 0,
            revealed: 0,
            tallies: [0; 2],
            outcome: None,
            winner: None,
            payment: Payment::default(),
            paid_bounty: None,
        }
    }

    fn phase(&self, now: u64) -> Phase {
        if self.outcome.is_some() {
            Phase::Finalized
        } else if now < self.terms.starts_at.0 {
            Phase::Funding
        } else if !self.funded || now >= self.terms.reveal_end.0 {
            Phase::AwaitingFinalization
        } else if now < self.terms.commit_end.0 {
            Phase::Commit
        } else {
            Phase::Reveal
        }
    }

    fn bounty_recipient(&self) -> Option<&AccountId> {
        match self.outcome? {
            Outcome::Winner => self
                .winner
                .map(|i| &self.terms.candidates[usize::from(i)].artist),
            Outcome::Tie | Outcome::NoQuorum => Some(&self.terms.sponsor),
            Outcome::Unfunded => None,
        }
    }
}

#[near(serializers = [borsh])]
struct Vote {
    amount: u128,
    commitment: [u8; 32],
    revealed_choice: Option<u8>,
    withdrawal: Payment,
}

impl Vote {
    fn view(&self) -> VoteView {
        VoteView {
            amount: U128(self.amount),
            commitment: hex(&self.commitment),
            revealed_choice: self.revealed_choice,
            withdrawal_state: self.withdrawal.state,
        }
    }
}

#[near(serializers = [borsh])]
struct PaidBounty {
    recipient: AccountId,
    token_id: AccountId,
    amount: U128,
    paid_at: U64,
}

#[near(serializers = [json])]
pub struct ConfigView {
    curator: AccountId,
    token_id: AccountId,
    quote_token_id: AccountId,
}

#[near(serializers = [json])]
pub struct RoundView {
    round_id: u32,
    #[serde(flatten)]
    terms: RoundTerms,
    phase: Phase,
    funded: bool,
    committed_count: u16,
    min_lock: U128,
    locked: U128,
    revealed: U128,
    tallies: [U128; 2],
    outcome: Option<Outcome>,
    winner: Option<u8>,
    bounty_state: PaymentState,
}

#[near(serializers = [json])]
pub struct VoteView {
    amount: U128,
    commitment: String,
    revealed_choice: Option<u8>,
    withdrawal_state: PaymentState,
}

#[near(serializers = [json])]
pub struct PublicVoteView {
    account_id: AccountId,
    #[serde(flatten)]
    vote: VoteView,
}

#[near(serializers = [json])]
pub struct PayoutView {
    recipient: AccountId,
    token_id: AccountId,
    amount: U128,
    state: PaymentState,
    paid_at: Option<U64>,
    attempt: u32,
}

#[near(serializers = [json])]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Transfer {
    Fund { round_id: u32 },
    Commit { round_id: u32, commitment: String },
}

fn hex_byte(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

fn hash_bytes(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 {
        return None;
    }
    let mut bytes = [0; 32];
    for (out, pair) in bytes.iter_mut().zip(value.as_bytes().chunks_exact(2)) {
        *out = hex_byte(pair[0])? << 4 | hex_byte(pair[1])?;
    }
    Some(bytes)
}

fn hex(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        result.push(char::from(ALPHABET[usize::from(byte >> 4)]));
        result.push(char::from(ALPHABET[usize::from(byte & 15)]));
    }
    result
}

fn commitment(
    contract: &AccountId,
    round_id: u32,
    voter: &AccountId,
    index: u8,
    salt: &str,
) -> [u8; 32] {
    env::sha256_array(
        format!("sealround-chapter-v1|{contract}|{round_id}|{voter}|{index}|{salt}").as_bytes(),
    )
}

fn emit(event: &str, data: Value) {
    let record = json!({
        "standard": "sealround_chapters",
        "version": "1.0.0",
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{record}"));
}

fn transfer_succeeded() -> Option<bool> {
    if env::promise_results_count() != 1 {
        return None;
    }
    Some(matches!(
        env::promise_result_checked(0, 128),
        Ok(_) | Err(PromiseError::TooLong(_))
    ))
}

fn valid_title(title: &str) -> bool {
    !title.trim().is_empty() && title.len() <= MAX_TITLE_BYTES
}

fn matches_image_signature(mime_type: &str, bytes: &[u8]) -> bool {
    match mime_type {
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    }
}

fn artist_roster_key(round_id: u32) -> [u8; 5] {
    let mut key = [0; 5];
    key[0] = b'i';
    key[1..].copy_from_slice(&round_id.to_le_bytes());
    key
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Chapters {
    curator: AccountId,
    token_id: AccountId,
    quote_token_id: AccountId,
    round_count: u32,
    rounds: LookupMap<u32, Round>,
    votes: LookupMap<(u32, AccountId), Vote>,
    vote_order: LookupMap<(u32, u16), AccountId>,
    art_submissions: LookupMap<u32, Vec<ArtSubmission>>,
    art_files: LookupMap<(u32, u32), Vec<u8>>,
}

#[near]
impl Chapters {
    #[init]
    #[private]
    pub fn new(curator: AccountId, token_id: AccountId, quote_token_id: AccountId) -> Self {
        Self::initialize(curator, token_id, quote_token_id)
    }

    /// The factory initializes the keyless child in the same batch that creates it.
    #[init]
    pub fn new_from_factory(
        curator: AccountId,
        token_id: AccountId,
        quote_token_id: AccountId,
    ) -> Self {
        let caller = env::predecessor_account_id();
        require!(
            env::current_account_id().get_parent_account_id() == Some(caller.as_ref()),
            "Only the immediate parent can initialize a Chapters escrow from a factory"
        );
        let chapters = Self::initialize(curator, token_id, quote_token_id);
        env::storage_write(SUBMISSIONS_REQUIRED, &[]);
        chapters
    }

    fn initialize(curator: AccountId, token_id: AccountId, quote_token_id: AccountId) -> Self {
        require!(
            token_id != quote_token_id,
            "Voting and quote tokens must be different"
        );
        env::storage_write(LAST_WINNER, &[]);
        Self {
            curator,
            token_id,
            quote_token_id,
            round_count: 0,
            rounds: LookupMap::new(Key::Rounds),
            votes: LookupMap::new(Key::Votes),
            vote_order: LookupMap::new(Key::VoteOrder),
            art_submissions: LookupMap::new(Key::ArtSubmissions),
            art_files: LookupMap::new(Key::ArtFiles),
        }
    }

    fn next_round(&self) -> (u32, Option<String>) {
        require!(self.round_count < MAX_ROUNDS, "Round limit reached");
        if self.round_count == 0 {
            return (1, None);
        }
        let previous = self.rounds.get(&self.round_count).expect("Missing round");
        require!(
            previous.outcome.is_some(),
            "Finalize the previous round first"
        );
        (self.round_count + 1, self.last_winner())
    }

    fn last_winner(&self) -> Option<String> {
        match env::storage_read(LAST_WINNER) {
            Some(bytes) if bytes.is_empty() => None,
            Some(bytes) => Some(String::from_utf8(bytes).expect("Invalid winning digest")),
            // Escrows initialized before this cache used only the historical rounds.
            None => (1..=self.round_count).rev().find_map(|id| {
                let round = self.rounds.get(&id)?;
                round.winner.map(|choice| {
                    round.terms.candidates[usize::from(choice)]
                        .content_sha256
                        .clone()
                })
            }),
        }
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            curator: self.curator.clone(),
            token_id: self.token_id.clone(),
            quote_token_id: self.quote_token_id.clone(),
        }
    }

    pub fn get_round_count(&self) -> u32 {
        self.round_count
    }

    pub fn get_round(&self, round_id: u32) -> Option<RoundView> {
        let r = self.rounds.get(&round_id)?;
        Some(RoundView {
            round_id,
            terms: r.terms.clone(),
            phase: r.phase(env::block_timestamp()),
            funded: r.funded,
            committed_count: r.committed_count,
            min_lock: U128(r.terms.min_lock()),
            locked: U128(r.locked),
            revealed: U128(r.revealed),
            tallies: r.tallies.map(U128),
            outcome: r.outcome,
            winner: r.winner,
            bounty_state: r.payment.state,
        })
    }

    pub fn get_vote(&self, round_id: u32, account_id: AccountId) -> Option<VoteView> {
        self.votes.get(&(round_id, account_id)).map(Vote::view)
    }

    /// Public vote records in commit order. A choice appears only after reveal.
    pub fn get_votes(
        &self,
        round_id: u32,
        from_index: Option<u16>,
        limit: Option<u16>,
    ) -> Vec<PublicVoteView> {
        let Some(round) = self.rounds.get(&round_id) else {
            return Vec::new();
        };
        let start = from_index.unwrap_or(0);
        let size = limit.unwrap_or(DEFAULT_VOTE_PAGE).min(MAX_VOTE_PAGE);
        let end = start.saturating_add(size).min(round.committed_count);
        (start..end)
            .map(|index| {
                let account_id = self
                    .vote_order
                    .get(&(round_id, index))
                    .expect("Missing vote index")
                    .clone();
                let vote = self
                    .get_vote(round_id, account_id.clone())
                    .expect("Missing indexed vote");
                PublicVoteView { account_id, vote }
            })
            .collect()
    }

    /// Due payment terms for a finalized round. A paid record comes only from the FT callback.
    pub fn get_payout(&self, round_id: u32) -> Option<PayoutView> {
        let round = self.rounds.get(&round_id)?;
        if let Some(receipt) = &round.paid_bounty {
            return Some(PayoutView {
                recipient: receipt.recipient.clone(),
                token_id: receipt.token_id.clone(),
                amount: receipt.amount,
                state: PaymentState::Paid,
                paid_at: Some(receipt.paid_at),
                attempt: round.payment.attempt,
            });
        }
        Some(PayoutView {
            recipient: round.bounty_recipient()?.clone(),
            token_id: self.quote_token_id.clone(),
            amount: round.terms.bounty,
            state: round.payment.state,
            paid_at: None,
            attempt: round.payment.attempt,
        })
    }

    /// Metadata for every artist submission to a round, in arrival order.
    pub fn get_submissions(&self, round_id: u32) -> Vec<ArtSubmission> {
        self.art_submissions
            .get(&round_id)
            .cloned()
            .unwrap_or_default()
    }

    /// The original artwork bytes, using standard base64 with padding.
    pub fn get_art(&self, round_id: u32, submission_id: u32) -> Option<String> {
        self.art_files
            .get(&(round_id, submission_id))
            .map(|bytes| BASE64.encode(bytes))
    }

    /// The curator's bounded list for the upcoming round.
    pub fn get_artists(&self, round_id: u32) -> Vec<AccountId> {
        env::storage_read(&artist_roster_key(round_id))
            .map(|bytes| near_sdk::serde_json::from_slice(&bytes).expect("Invalid artist roster"))
            .unwrap_or_default()
    }

    pub fn artist_roster_cost(&self, round_id: u32) -> U128 {
        U128(if env::storage_has_key(&artist_roster_key(round_id)) {
            0
        } else {
            ARTIST_ROSTER_BYTES * env::storage_byte_cost().as_yoctonear()
        })
    }

    /// Already submitted entries keep their slots and identifiers.
    #[payable]
    pub fn set_artists(&mut self, round_id: u32, artists: Vec<AccountId>) {
        require!(
            env::predecessor_account_id() == self.curator,
            "Only the curator can invite artists"
        );
        let (next_id, _) = self.next_round();
        require!(round_id == next_id, "Invite artists for the next round");
        require!(
            (2..=MAX_SUBMISSIONS).contains(&artists.len()),
            "Invite 2 to 8 artists"
        );
        require!(
            artists
                .iter()
                .enumerate()
                .all(|(index, artist)| !artists[..index].contains(artist)),
            "Invite each artist once"
        );
        require!(
            self.get_submissions(round_id)
                .iter()
                .all(|submission| artists.contains(&submission.candidate.artist)),
            "Keep artists who have already submitted"
        );
        require!(
            env::attached_deposit().as_yoctonear() == self.artist_roster_cost(round_id).0,
            "Attach the exact artist roster storage cost"
        );
        let roster = near_sdk::serde_json::to_vec(&artists).expect("Artist roster JSON");
        env::storage_write(&artist_roster_key(round_id), &roster);
    }

    pub fn art_storage_cost(&self, byte_length: u32) -> U128 {
        require!(
            (1..=MAX_ART_BYTES).contains(&byte_length),
            "Artwork must be 1 to 49152 bytes"
        );
        U128(
            (u128::from(byte_length) + ART_OVERHEAD_BYTES)
                * env::storage_byte_cost().as_yoctonear(),
        )
    }

    /// The artist prepays permanent storage and signs for their own entry.
    #[payable]
    pub fn submit_art(
        &mut self,
        round_id: u32,
        title: String,
        mime_type: String,
        image_base64: String,
        parent_sha256: Option<String>,
    ) -> ArtSubmission {
        let (next_id, parent) = self.next_round();
        require!(round_id == next_id, "Submit art for the next round");
        require!(
            parent_sha256 == parent,
            "Artwork parent must match the previous winner"
        );
        let artist = env::predecessor_account_id();
        require!(
            artist == env::signer_account_id(),
            "The artist must sign directly"
        );
        require!(
            self.get_artists(round_id).contains(&artist),
            "The curator must invite this artist"
        );
        require!(valid_title(&title), "Invalid artwork title");

        let mut submissions = self.get_submissions(round_id);
        require!(
            submissions.len() < MAX_SUBMISSIONS,
            "Artwork submission limit reached"
        );
        require!(
            submissions
                .iter()
                .all(|submission| submission.candidate.artist != artist),
            "This artist has already submitted to this round"
        );
        require!(
            image_base64.len() <= (MAX_ART_BYTES as usize).div_ceil(3) * 4,
            "Artwork exceeds 49152 bytes"
        );
        let bytes = BASE64
            .decode(image_base64)
            .expect("Artwork needs standard base64");
        require!(
            matches_image_signature(&mime_type, &bytes),
            "Artwork must match its JPEG, PNG or WebP type"
        );
        require!(
            env::attached_deposit().as_yoctonear() == self.art_storage_cost(bytes.len() as u32).0,
            "Attach the exact artwork storage cost"
        );

        let content_sha256 = hex(&env::sha256_array(&bytes));
        require!(
            parent_sha256.as_ref() != Some(&content_sha256),
            "Artwork must differ from the previous winner"
        );
        require!(
            submissions
                .iter()
                .all(|submission| submission.candidate.content_sha256 != content_sha256),
            "This artwork has already been submitted to this round"
        );
        let submission_id = submissions.len() as u32 + 1;
        let entry = ArtSubmission {
            submission_id,
            round_id,
            candidate: Candidate {
                title,
                content_sha256,
                artist,
            },
            mime_type,
            parent_sha256,
        };
        submissions.push(entry.clone());
        self.art_submissions.insert(round_id, submissions);
        self.art_files.insert((round_id, submission_id), bytes);
        emit("art_submitted", json!(entry));
        entry
    }

    pub fn storage_cost(&self, max_voters: u16) -> U128 {
        require!(
            (1..=MAX_VOTERS).contains(&max_voters),
            "Voter slots must be 1 to 512"
        );
        U128(
            (ROUND_BYTES + VOTE_BYTES * u128::from(max_voters))
                * env::storage_byte_cost().as_yoctonear(),
        )
    }

    /// The curator reserves storage for the entire round. Holders only transfer their vote lock.
    #[payable]
    #[allow(
        clippy::too_many_arguments,
        reason = "explicit JSON arguments for immutable round terms"
    )]
    pub fn create_round(
        &mut self,
        title: String,
        candidates: [Candidate; 2],
        sponsor: AccountId,
        bounty: U128,
        quorum: U128,
        max_voters: u16,
        starts_at: U64,
        commit_end: U64,
        reveal_end: U64,
        submission_ids: Option<[u32; 2]>,
    ) -> u32 {
        let now = env::block_timestamp();
        require!(
            env::predecessor_account_id() == self.curator,
            "Only the curator can create a round"
        );
        let (round_id, parent_sha256) = self.next_round();
        require!(valid_title(&title), "Invalid round title");
        require!(
            candidates
                .iter()
                .all(|c| valid_title(&c.title) && hash_bytes(&c.content_sha256).is_some()),
            "Each candidate needs a title and lowercase SHA-256"
        );
        require!(
            candidates[0].artist != candidates[1].artist,
            "Candidates need distinct artists"
        );
        require!(
            candidates[0].content_sha256 != candidates[1].content_sha256,
            "Candidates need distinct content"
        );
        let submissions = self.get_submissions(round_id);
        if let Some(ids) = submission_ids {
            require!(ids[0] != ids[1], "Choose two different submissions");
            for (id, candidate) in ids.into_iter().zip(&candidates) {
                require!(
                    submissions.iter().any(|art| {
                        art.submission_id == id
                            && &art.candidate == candidate
                            && art.parent_sha256 == parent_sha256
                    }),
                    "Candidates must match their artwork submissions"
                );
            }
        } else {
            require!(
                !env::storage_has_key(SUBMISSIONS_REQUIRED),
                "Choose two signed artist submissions"
            );
            // Legacy bundled art is available only while the round has no submitted entries.
            require!(submissions.is_empty(), "Choose from the submitted artwork");
            require!(
                self.rounds
                    .get(&self.round_count)
                    .is_none_or(|previous| previous.terms.submission_ids.is_none()),
                "Continue the story with submitted artwork"
            );
        }
        require!(
            bounty.0 > 0 && quorum.0 > 0,
            "Bounty and quorum must be positive"
        );
        require!(
            now < starts_at.0 && starts_at.0 < commit_end.0 && commit_end.0 < reveal_end.0,
            "Invalid round windows"
        );
        require!(
            reveal_end.0 - now <= MAX_ROUND_NS,
            "Round must end within 90 days"
        );
        require!(
            env::attached_deposit().as_yoctonear() == self.storage_cost(max_voters).0,
            "Attach the exact storage cost"
        );
        self.round_count = round_id;
        self.rounds.insert(
            round_id,
            Round::new(RoundTerms {
                title,
                candidates,
                submission_ids,
                parent_sha256,
                sponsor,
                bounty,
                quorum,
                max_voters,
                starts_at,
                commit_end,
                reveal_end,
            }),
        );
        emit("round_created", json!({ "round_id": round_id }));
        round_id
    }

    pub fn reveal(&mut self, round_id: u32, candidate_index: u8, salt: String) {
        let voter = env::predecessor_account_id();
        require!(
            candidate_index < 2 && hash_bytes(&salt).is_some(),
            "Invalid choice or salt"
        );
        let round = self
            .rounds
            .get_mut(&round_id)
            .expect("Round does not exist");
        require!(
            round.phase(env::block_timestamp()) == Phase::Reveal,
            "Reveal window is closed"
        );
        let vote = self
            .votes
            .get_mut(&(round_id, voter.clone()))
            .expect("No locked vote");
        require!(vote.revealed_choice.is_none(), "Vote already revealed");
        require!(
            vote.commitment
                == commitment(
                    &env::current_account_id(),
                    round_id,
                    &voter,
                    candidate_index,
                    &salt
                ),
            "Choice and salt do not match the sealed vote"
        );
        vote.revealed_choice = Some(candidate_index);
        // Only committed weight can reveal once. Its sum is bounded by locked.
        round.revealed += vote.amount;
        round.tallies[usize::from(candidate_index)] += vote.amount;
        emit(
            "vote_revealed",
            json!({
                "round_id": round_id, "voter": voter, "candidate_index": candidate_index, "amount": U128(vote.amount),
            }),
        );
    }

    pub fn finalize(&mut self, round_id: u32) -> RoundView {
        let round = self
            .rounds
            .get_mut(&round_id)
            .expect("Round does not exist");
        if round.outcome.is_none() {
            require!(
                round.phase(env::block_timestamp()) == Phase::AwaitingFinalization,
                "Round cannot finalize yet"
            );
            round.outcome = Some(if !round.funded {
                Outcome::Unfunded
            } else if round.revealed < round.terms.quorum.0 {
                Outcome::NoQuorum
            } else if round.tallies[0] == round.tallies[1] {
                Outcome::Tie
            } else {
                let choice = u8::from(round.tallies[1] > round.tallies[0]);
                round.winner = Some(choice);
                env::storage_write(
                    LAST_WINNER,
                    round.terms.candidates[usize::from(choice)]
                        .content_sha256
                        .as_bytes(),
                );
                Outcome::Winner
            });
            emit(
                "round_finalized",
                json!({
                    "round_id": round_id, "outcome": round.outcome, "winner": round.winner,
                    "tallies": round.tallies.map(U128),
                }),
            );
        }
        self.get_round(round_id).expect("Round does not exist")
    }

    #[payable]
    pub fn withdraw_vote(&mut self, round_id: u32) -> Promise {
        assert_one_yocto();
        let voter = env::predecessor_account_id();
        let round = self.rounds.get(&round_id).expect("Round does not exist");
        require!(round.outcome.is_some(), "Finalize the round first");
        let vote = self
            .votes
            .get_mut(&(round_id, voter.clone()))
            .expect("No locked vote");
        let attempt = vote.withdrawal.start();
        ext_ft::ext(self.token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(
                voter.clone(),
                U128(vote.amount),
                Some(format!("Chapter {round_id} vote return")),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_withdraw_vote(round_id, voter, attempt),
            )
    }

    #[payable]
    pub fn claim_bounty(&mut self, round_id: u32) -> Promise {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let round = self
            .rounds
            .get_mut(&round_id)
            .expect("Round does not exist");
        require!(
            round.bounty_recipient() == Some(&account),
            "No bounty or refund due to this account"
        );
        let attempt = round.payment.start();
        ext_ft::ext(self.quote_token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(
                account,
                round.terms.bounty,
                Some(format!("Sealround chapter {round_id} payout {attempt}")),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_claim_bounty(round_id, attempt),
            )
    }

    #[private]
    pub fn on_withdraw_vote(&mut self, round_id: u32, voter: AccountId, attempt: u32) -> bool {
        let Some(paid) = transfer_succeeded() else {
            return false;
        };
        let Some(vote) = self.votes.get_mut(&(round_id, voter.clone())) else {
            return false;
        };
        if !vote.withdrawal.finish(attempt, paid) {
            return false;
        }
        emit(
            "vote_payment",
            json!({
                "round_id": round_id, "voter": voter, "amount": U128(vote.amount), "paid": paid,
            }),
        );
        paid
    }

    #[private]
    pub fn on_claim_bounty(&mut self, round_id: u32, attempt: u32) -> bool {
        let Some(paid) = transfer_succeeded() else {
            return false;
        };
        let Some(round) = self.rounds.get_mut(&round_id) else {
            return false;
        };
        let Some(recipient) = round.bounty_recipient().cloned() else {
            return false;
        };
        if !round.payment.finish(attempt, paid) {
            return false;
        }
        if paid {
            round.paid_bounty = Some(PaidBounty {
                recipient: recipient.clone(),
                token_id: self.quote_token_id.clone(),
                amount: round.terms.bounty,
                paid_at: U64(env::block_timestamp()),
            });
        }
        emit(
            "bounty_payment",
            json!({
                "round_id": round_id, "attempt": attempt, "account": recipient, "amount": round.terms.bounty,
                "token_id": self.quote_token_id, "paid": paid,
                "paid_at": round.paid_bounty.as_ref().map(|receipt| receipt.paid_at),
            }),
        );
        paid
    }
}

#[near]
impl FungibleTokenReceiver for Chapters {
    /// Return the entire transfer on any refusal. Only the configured FTs can fund or lock.
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let refused = PromiseOrValue::Value(amount);
        if amount.0 == 0 || msg.len() > 224 {
            return refused;
        }
        let Ok(transfer) = near_sdk::serde_json::from_str::<Transfer>(&msg) else {
            return refused;
        };
        let token = env::predecessor_account_id();
        let now = env::block_timestamp();
        match transfer {
            Transfer::Fund { round_id } if token == self.quote_token_id => {
                let Some(round) = self.rounds.get_mut(&round_id) else {
                    return refused;
                };
                if round.phase(now) != Phase::Funding
                    || round.funded
                    || sender_id != round.terms.sponsor
                    || amount != round.terms.bounty
                {
                    return refused;
                }
                round.funded = true;
                emit(
                    "bounty_funded",
                    json!({ "round_id": round_id, "sponsor": sender_id, "amount": amount }),
                );
            }
            Transfer::Commit {
                round_id,
                commitment,
            } if token == self.token_id => {
                let Some(commitment) = hash_bytes(&commitment) else {
                    return refused;
                };
                let Some(round) = self.rounds.get_mut(&round_id) else {
                    return refused;
                };
                let key = (round_id, sender_id.clone());
                if round.phase(now) != Phase::Commit
                    || amount.0 < round.terms.min_lock()
                    || round.committed_count >= round.terms.max_voters
                    || self.votes.contains_key(&key)
                {
                    return refused;
                }
                let Some(locked) = round.locked.checked_add(amount.0) else {
                    return refused;
                };
                round.locked = locked;
                self.vote_order
                    .insert((round_id, round.committed_count), sender_id.clone());
                round.committed_count += 1;
                self.votes.insert(
                    key,
                    Vote {
                        amount: amount.0,
                        commitment,
                        revealed_choice: None,
                        withdrawal: Payment::default(),
                    },
                );
                emit(
                    "vote_committed",
                    json!({ "round_id": round_id, "voter": sender_id, "amount": amount }),
                );
            }
            _ => return refused,
        }
        PromiseOrValue::Value(U128(0))
    }
}

#[cfg(test)]
mod tests;
