//! Creating a sale and getting it ready for bids: the token deploy, the
//! sealer's public key (TEE mode) and this contract's registration on the
//! quote token.

use fairground_clearing::hash::parse_hex;
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{AccountId, Gas, NearToken, Promise, env, near};

use crate::bids::bid_set_seed;
use crate::costs::{
    LIQUIDITY_NEAR_RESERVE, LIQUIDITY_RECORD_BYTES, MAX_ACCOUNT_ID_LEN, ON_QUOTE_REGISTERED_GAS,
    ON_SEALER_KEY_GAS, ON_TOKEN_DEPLOYED_GAS, OUTLAYER_COMPUTE_DEPOSIT, OWN_WORK_GAS,
    QUOTE_REGISTRATION_COST, STORAGE_DEPOSIT_GAS, TOKEN_INIT_GAS, TOKEN_STORAGE_DEPOSIT,
    TOKEN_WASM, outlayer_request_gas, per_bid_reserve, sale_storage_cost, storage_cost,
    token_deploy_actions_gas, token_deploy_balance,
};
use crate::events::{emit, hex};
use crate::outlayer::{self, Outcome, pubkey_input};
use crate::sale::{NewSale, Proceeds, SaleResult};
use crate::{
    CreateSaleParams, Error, Fairground, FairgroundExt, Phase, RevealMode, Sale, SaleMeta,
    StepState, ext_ft, promise_succeeded, require_gas,
};

/// What `create_sale` charges, part by part (DESIGN "Storage and cost").
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CreateCost {
    pub sale_storage: u128,
    pub token_deploy: u128,
    pub bid_reserve: u128,
    /// The creator's registrations on the sale token and the quote token.
    pub creator_registrations: u128,
    pub quote_registration: u128,
    pub sealer_key: u128,
    /// Launch liquidity: the record's storage plus `LIQUIDITY_NEAR_RESERVE`.
    pub liquidity: u128,
}

impl CreateCost {
    pub fn total(&self) -> u128 {
        self.sale_storage
            + self.token_deploy
            + self.bid_reserve
            + self.creator_registrations
            + self.quote_registration
            + self.sealer_key
            + self.liquidity
    }
}

#[near]
impl Fairground {
    /// Creates a sale. Requires attached NEAR >= `get_create_cost(params)` and
    /// refunds the excess at once. Writes the sale (status `setup`), then
    /// deploys its token, asks the sealer for the sale key (TEE mode) and, the
    /// first time a quote token is used, registers this contract on it.
    #[payable]
    #[handle_result]
    pub fn create_sale(&mut self, params: CreateSaleParams) -> Result<(), Error> {
        let now = env::block_timestamp();
        let contract = env::current_account_id();
        let creator = env::predecessor_account_id();
        let new_sale = params.validate(now, &contract, &self.config)?;
        if self.sales.contains_key(&new_sale.sale_id) {
            return Err(Error::SaleExists);
        }
        let cost = self.create_cost(&new_sale);
        let attached = env::attached_deposit().as_yoctonear();
        if attached < cost.total() {
            return Err(Error::DepositTooLow {
                required: cost.total(),
                attached,
            });
        }
        let register_quote = cost.quote_registration > 0;
        require_gas(create_sale_gas(new_sale.reveal_mode, register_quote))?;

        let NewSale {
            sale_id,
            token,
            terms,
            meta,
            reveal_mode,
            reveal_window,
            settle_timeout,
            quote_token,
            liquidity,
        } = new_sale;
        let num = self.sale_ids.len();
        let sale = Sale {
            num,
            creator: creator.clone(),
            token,
            quote_token,
            created_at: now,
            terms,
            reveal_mode,
            reveal_window,
            settle_timeout,
            sealer_code_hash: self.config.sealer_code_hash.clone(),
            token_deploy_balance: cost.token_deploy,
            token_state: StepState::Pending,
            key_state: match reveal_mode {
                RevealMode::Tee => StepState::Pending,
                RevealMode::CommitReveal => StepState::Done,
            },
            sealer_pubkey: None,
            key_request_block: (reveal_mode == RevealMode::Tee).then(env::block_height),
            phase: Phase::Setup,
            closed_at: None,
            bid_count: 0,
            total_deposits: 0,
            bid_set_state: bid_set_seed(&sale_id),
            result: SaleResult::default(),
            proceeds: Proceeds::default(),
            liquidity,
        };

        self.deploy_token(&sale_id, &sale, &meta).detach();
        let excess = attached - cost.total();
        if reveal_mode == RevealMode::Tee {
            // The excess rides along as OutLayer payment, which refunds what
            // it does not charge to the creator: headroom if OutLayer's prices
            // have risen above the deposit's 2x margin.
            self.request_sealer_key(&sale_id, &creator, cost.sealer_key + excess)
                .detach();
        } else if excess > 0 {
            Promise::new(creator.clone())
                .transfer(NearToken::from_yoctonear(excess))
                .detach();
        }
        if register_quote {
            self.quote_tokens
                .insert(sale.quote_token.clone(), StepState::Pending);
            register_on_quote_token(&sale.quote_token).detach();
        }

        emit(
            "sale_created",
            json!({
                "sale_id": sale_id,
                "creator": creator,
                "token": sale.token,
                "quote_token": sale.quote_token,
                "reveal_mode": reveal_mode,
                "bid_start": near_sdk::json_types::U64(sale.terms.bid_start),
                "bid_end": near_sdk::json_types::U64(sale.terms.bid_end),
                "max_bids": sale.terms.max_bids,
                "cost": U128(cost.total()),
            }),
        );
        self.sale_ids.push(sale_id.clone());
        self.meta.insert(num, meta);
        self.sales.insert(sale_id, sale);
        Ok(())
    }

    /// Retries whatever setup step failed: the token deploy, the sealer key
    /// (attach at least `OUTLAYER_COMPUTE_DEPOSIT`; all of it goes to OutLayer
    /// as payment, you become the payer and it refunds what it does not
    /// charge, so attaching more gets a key through after a price rise) and
    /// this contract's quote-token registration. Anyone may call it. Token and
    /// key need the sale in `setup`; the registration can be retried until the
    /// sale is final. NEAR attached without a key retry is refunded.
    #[payable]
    #[handle_result]
    pub fn retry_setup(&mut self, sale_id: String) -> Result<(), Error> {
        let caller = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();
        let sale = self.sale(&sale_id)?.clone();
        let now = env::block_timestamp();
        if sale.is_final() {
            return Err(Error::WrongPhase {
                action: "retry setup",
                status: sale.status(now).as_str(),
            });
        }
        let in_setup = sale.phase == Phase::Setup;
        let retry_token = in_setup && sale.token_state == StepState::Failed;
        let retry_key = in_setup && sale.key_state == StepState::Failed;
        let retry_quote = self.quote_tokens.get(&sale.quote_token) == Some(&StepState::Failed);
        if !(retry_token || retry_key || retry_quote) {
            return Err(Error::NothingToRetry);
        }
        if retry_key && attached < OUTLAYER_COMPUTE_DEPOSIT {
            return Err(Error::DepositTooLow {
                required: OUTLAYER_COMPUTE_DEPOSIT,
                attached,
            });
        }
        // A key retry forwards everything attached (see the doc above).
        let key_deposit = if retry_key { attached } else { 0 };
        let mut gas = OWN_WORK_GAS;
        if retry_token {
            gas = gas.saturating_add(token_deploy_gas());
        }
        if retry_key {
            gas = gas.saturating_add(sealer_key_gas(&env::current_account_id(), &sale_id));
        }
        if retry_quote {
            gas = gas.saturating_add(quote_registration_gas());
        }
        require_gas(gas)?;

        if retry_token {
            // The failed batch returned the deploy balance to this contract.
            let meta = self
                .meta
                .get(&sale.num)
                .cloned()
                .ok_or(Error::UnknownSale)?;
            self.deploy_token(&sale_id, &sale, &meta).detach();
        }
        if retry_key {
            self.request_sealer_key(&sale_id, &caller, key_deposit)
                .detach();
        }
        if retry_quote {
            // A failed registration returned its deposit to this contract.
            self.quote_tokens
                .insert(sale.quote_token.clone(), StepState::Pending);
            register_on_quote_token(&sale.quote_token).detach();
        }
        let sale = self.sale_mut(&sale_id)?;
        if retry_token {
            sale.token_state = StepState::Pending;
        }
        if retry_key {
            sale.key_state = StepState::Pending;
            sale.key_request_block = Some(env::block_height());
        }
        if attached > key_deposit {
            Promise::new(caller)
                .transfer(NearToken::from_yoctonear(attached - key_deposit))
                .detach();
        }
        Ok(())
    }

    /// Result of the token batch (create, fund, deploy, `new`). A failed batch
    /// is undone as a whole and its NEAR comes back to this contract.
    #[private]
    pub fn on_token_deployed(&mut self, sale_id: String) -> bool {
        let ok = promise_succeeded(0);
        let Some(sale) = self.sales.get_mut(&sale_id) else {
            return false;
        };
        sale.token_state = if ok {
            StepState::Done
        } else {
            env::log_str("token deploy failed; retry_setup can retry it");
            StepState::Failed
        };
        self.mark_ready_if_set_up(&sale_id);
        ok
    }

    /// Result of the sealer's `pubkey` job: `{"v":1,"ok":true,"op":"pubkey",
    /// "sale_id":..,"pubkey":"<hex64>"}`. Anything else leaves the key failed
    /// for `retry_setup`, and the log says why (for an `ok: false` answer,
    /// the sealer's error code). Never panics.
    #[private]
    pub fn on_sealer_key(&mut self, sale_id: String, payer: AccountId, deposit: U128) -> bool {
        let outcome = outlayer::read_outcome();
        refund_if_refused(&outcome, &payer, deposit.0);
        let Some(sale) = self.sales.get_mut(&sale_id) else {
            return false;
        };
        if sale.key_state != StepState::Pending {
            return false;
        }
        let pubkey = match &outcome {
            Outcome::Output {
                reply: Ok(reply), ..
            } if reply.ok
                && reply.op.as_deref() == Some("pubkey")
                && reply.sale_id.as_deref() == Some(sale_id.as_str()) =>
            {
                reply.pubkey.as_deref().and_then(parse_hex::<32>)
            }
            _ => None,
        };
        match pubkey {
            Some(pubkey) => {
                sale.sealer_pubkey = Some(pubkey);
                sale.key_state = StepState::Done;
            }
            None => {
                env::log_str(&format!(
                    "sealer key request failed ({}); retry_setup can retry it",
                    failure_reason(&outcome)
                ));
                sale.key_state = StepState::Failed;
            }
        }
        self.mark_ready_if_set_up(&sale_id);
        pubkey.is_some()
    }

    /// Result of this contract's `storage_deposit` on a quote token.
    #[private]
    pub fn on_quote_registered(&mut self, quote_token: AccountId) -> bool {
        let ok = promise_succeeded(0);
        let state = if ok {
            StepState::Done
        } else {
            env::log_str("quote token registration failed; retry_setup can retry it");
            StepState::Failed
        };
        self.quote_tokens.insert(quote_token, state);
        ok
    }
}

impl Fairground {
    pub(crate) fn create_cost(&self, sale: &NewSale) -> CreateCost {
        // The creator is charged as the longest account id, so
        // `get_create_cost` (a view, which cannot know the caller) gives
        // exactly the amount `create_sale` charges.
        let accounts_len = MAX_ACCOUNT_ID_LEN + sale.quote_token.len() + sale.token.len();
        CreateCost {
            sale_storage: sale_storage_cost(
                sale.sale_id.len(),
                accounts_len,
                sale.meta.variable_len(),
            ),
            token_deploy: token_deploy_balance(sale.meta.token_metadata_len()),
            bid_reserve: per_bid_reserve(sale.reveal_mode) * u128::from(sale.terms.max_bids),
            creator_registrations: 2 * TOKEN_STORAGE_DEPOSIT,
            quote_registration: if self.quote_tokens.contains_key(&sale.quote_token) {
                0
            } else {
                QUOTE_REGISTRATION_COST
            },
            sealer_key: match sale.reveal_mode {
                RevealMode::Tee => OUTLAYER_COMPUTE_DEPOSIT,
                RevealMode::CommitReveal => 0,
            },
            liquidity: if sale.liquidity.is_some() {
                storage_cost(LIQUIDITY_RECORD_BYTES) + LIQUIDITY_NEAR_RESERVE
            } else {
                0
            },
        }
    }

    /// `<sale_id>.<this>`: create, fund, deploy the token, `new`, then
    /// `on_token_deployed`. The token mints the whole supply to this contract.
    fn deploy_token(&self, sale_id: &str, sale: &Sale, meta: &SaleMeta) -> Promise {
        let contract = env::current_account_id();
        let args = json!({
            "owner_id": contract,
            "total_supply": U128(sale.terms.total_supply),
            "metadata": {
                "spec": "ft-1.0.0",
                "name": meta.token_name,
                "symbol": meta.token_symbol,
                "icon": meta.icon,
                "reference": null,
                "reference_hash": null,
                "decimals": sale.terms.decimals,
            },
        });
        Promise::new(sale.token.clone())
            .create_account()
            .transfer(NearToken::from_yoctonear(sale.token_deploy_balance))
            .deploy_contract(TOKEN_WASM)
            .function_call(
                "new",
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                TOKEN_INIT_GAS,
            )
            .then(
                Self::ext(contract)
                    .with_static_gas(ON_TOKEN_DEPLOYED_GAS)
                    .on_token_deployed(sale_id.to_owned()),
            )
    }

    /// The sealer's `pubkey` job, paid by `payer` (OutLayer refunds the unused
    /// part to them).
    fn request_sealer_key(&self, sale_id: &str, payer: &AccountId, deposit: u128) -> Promise {
        let contract = env::current_account_id();
        let input = pubkey_input(&contract, sale_id);
        outlayer::request_execution(
            &self.config,
            &input,
            payer,
            NearToken::from_yoctonear(deposit),
        )
        .then(
            Self::ext(contract)
                .with_static_gas(ON_SEALER_KEY_GAS)
                .on_sealer_key(sale_id.to_owned(), payer.clone(), U128(deposit)),
        )
    }

    /// Moves a sale from `setup` to bidding once its setup is complete.
    fn mark_ready_if_set_up(&mut self, sale_id: &str) {
        let Some(sale) = self.sales.get_mut(sale_id) else {
            return;
        };
        if sale.phase != Phase::Setup || !sale.setup_complete() {
            return;
        }
        sale.phase = Phase::Bidding;
        emit(
            "sale_ready",
            json!({
                "sale_id": sale_id,
                "token": sale.token,
                "sealer_pubkey": sale.sealer_pubkey.as_ref().map(|key| hex(key)),
            }),
        );
    }
}

/// This contract's NEP-145 registration on a quote token, then `on_quote_registered`.
fn register_on_quote_token(quote_token: &AccountId) -> Promise {
    let contract = env::current_account_id();
    ext_ft::ext(quote_token.clone())
        .with_attached_deposit(NearToken::from_yoctonear(TOKEN_STORAGE_DEPOSIT))
        .with_static_gas(STORAGE_DEPOSIT_GAS)
        .storage_deposit(Some(contract.clone()), Some(true))
        .then(
            Fairground::ext(contract)
                .with_static_gas(ON_QUOTE_REGISTERED_GAS)
                .on_quote_registered(quote_token.clone()),
        )
}

/// A refused `request_execution` returns its deposit to this contract; pass it
/// back to whoever paid it.
pub(crate) fn refund_if_refused(outcome: &Outcome, payer: &AccountId, deposit: u128) {
    if *outcome == Outcome::Refused && deposit > 0 {
        Promise::new(payer.clone())
            .transfer(NearToken::from_yoctonear(deposit))
            .detach();
    }
}

/// Short description of an OutLayer outcome for logs. An `ok: false` answer
/// is described by [`failure_reason`], which names its error code.
pub(crate) fn outcome_label(outcome: &Outcome) -> &'static str {
    match outcome {
        Outcome::NoPromise => "no promise result",
        Outcome::Refused => "request refused by OutLayer",
        Outcome::NoOutput => "the job failed or timed out",
        Outcome::Output {
            reply: Err(why), ..
        } => why,
        Outcome::Output {
            reply: Ok(reply), ..
        } if !reply.ok => "the sealer reported an error",
        Outcome::Output { .. } => "unexpected sealer output",
    }
}

/// Why a request did not give what was asked, for logs and events:
/// `sealer_error: <code>` for an `ok: false` answer, else [`outcome_label`].
pub(crate) fn failure_reason(outcome: &Outcome) -> String {
    match outcome {
        Outcome::Output {
            reply: Ok(reply), ..
        } if !reply.ok => reply.error_label(),
        other => outcome_label(other).to_owned(),
    }
}

fn token_deploy_gas() -> Gas {
    token_deploy_actions_gas()
        .saturating_add(TOKEN_INIT_GAS)
        .saturating_add(ON_TOKEN_DEPLOYED_GAS)
}

fn sealer_key_gas(contract: &AccountId, sale_id: &str) -> Gas {
    outlayer_request_gas(pubkey_input(contract, sale_id).len()).saturating_add(ON_SEALER_KEY_GAS)
}

fn quote_registration_gas() -> Gas {
    STORAGE_DEPOSIT_GAS.saturating_add(ON_QUOTE_REGISTERED_GAS)
}

/// Gas `create_sale` needs for its promises plus its own work.
fn create_sale_gas(mode: RevealMode, register_quote: bool) -> Gas {
    let mut gas = OWN_WORK_GAS.saturating_add(token_deploy_gas());
    if mode == RevealMode::Tee {
        // The pubkey input is about 100 bytes; 256 covers any sale id.
        gas = gas
            .saturating_add(outlayer_request_gas(256))
            .saturating_add(ON_SEALER_KEY_GAS);
    }
    if register_quote {
        gas = gas.saturating_add(quote_registration_gas());
    }
    gas
}
