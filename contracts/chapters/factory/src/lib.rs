//! Opens one independently funded Chapters escrow per settled sale.

#[cfg(test)]
mod tests;

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, env, near, require,
};

const CHECK_SALE_GAS: Gas = Gas::from_tgas(15);
const DEPLOY_CALLBACK_GAS: Gas = Gas::from_tgas(115);
const INIT_GAS: Gas = Gas::from_tgas(30);
const DONE_GAS: Gas = Gas::from_tgas(20);
const ENABLE_GAS: Gas = Gas::from_tgas(160);
const REGISTRY_BYTES: u128 = 1_000;
const CHILD_BYTES: u128 = 2_000;
const MAX_SALE_RESPONSE: usize = 65_536;
const MAX_TITLE: usize = 96;
const MAX_BRIEF: usize = 512;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Deploying,
    Enabled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Registration {
    phase: Phase,
    contract_id: AccountId,
    curator: AccountId,
    token_id: AccountId,
    quote_token_id: AccountId,
    title: String,
    brief: String,
}

#[near(serializers = [json])]
pub struct EnableResult {
    enabled: bool,
    error: Option<&'static str>,
}

#[near(serializers = [json])]
struct Sale {
    sale_id: String,
    status: String,
    creator: AccountId,
    token: AccountId,
    quote_token: AccountId,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct ChaptersFactory {
    sale_contract: AccountId,
    chapters_code_hash: [u8; 32],
    registrations: LookupMap<String, Registration>,
}

#[near]
impl ChaptersFactory {
    #[init]
    #[private]
    pub fn new(sale_contract: AccountId, chapters_code_hash: String) -> Self {
        require!(
            env::current_account_id().as_str().len() <= 32,
            "Factory account ID must fit in 32 bytes"
        );
        require!(
            sale_contract != env::current_account_id(),
            "Use a distinct sale contract"
        );
        Self {
            sale_contract,
            chapters_code_hash: parse_hash(&chapters_code_hash)
                .expect("Expected lowercase SHA-256 hex"),
            registrations: LookupMap::new(b"r"),
        }
    }

    pub fn enable_cost(&self) -> U128 {
        U128(storage_cost(REGISTRY_BYTES + CHILD_BYTES).as_yoctonear())
    }

    pub fn get_chapters(&self, sale_id: String) -> Option<Registration> {
        if !valid_sale_id(&sale_id) {
            return None;
        }
        self.registrations.get(&sale_id).cloned()
    }

    /// Authenticate against the configured sale contract before reserving state.
    #[payable]
    pub fn enable_chapters(&mut self, sale_id: String, title: String, brief: String) -> Promise {
        let curator = env::predecessor_account_id();
        require!(
            curator == env::signer_account_id(),
            "The sale creator must sign directly"
        );
        require!(valid_sale_id(&sale_id), "Invalid sale ID");
        require!(
            valid_text(&title, MAX_TITLE),
            "Story title must be 1 to 96 bytes"
        );
        require!(
            valid_text(&brief, MAX_BRIEF),
            "Story brief must be 1 to 512 bytes"
        );
        require!(
            env::attached_deposit().as_yoctonear() == self.enable_cost().0,
            "Attach the exact Chapters setup cost"
        );
        require!(env::prepaid_gas() >= ENABLE_GAS, "Attach at least 160 TGas");
        require!(
            self.registrations.get(&sale_id).is_none(),
            "Chapters already exist for this sale"
        );

        Promise::new(self.sale_contract.clone())
            .function_call("get_sale", json_bytes(json!({ "sale_id": sale_id })), NearToken::from_yoctonear(0), CHECK_SALE_GAS)
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_sale_checked",
                    json_bytes(json!({ "sale_id": sale_id, "curator": curator, "title": title, "brief": brief })),
                    NearToken::from_yoctonear(0),
                    DEPLOY_CALLBACK_GAS,
                ),
            )
    }

    #[private]
    pub fn on_sale_checked(
        &mut self,
        sale_id: String,
        curator: AccountId,
        title: String,
        brief: String,
    ) -> PromiseOrValue<EnableResult> {
        require!(
            env::promise_results_count() == 1,
            "Expected one sale receipt"
        );
        let sale = env::promise_result_checked(0, MAX_SALE_RESPONSE)
            .ok()
            .and_then(|result| serde_json::from_slice::<Sale>(&result).ok());
        let Some(sale) = sale else {
            return PromiseOrValue::Value(refund(
                curator,
                self.enable_cost().0,
                "The sale could not be read.",
            ));
        };
        if sale.sale_id != sale_id
            || sale.status != "settled"
            || sale.creator != curator
            || sale.token == sale.quote_token
        {
            return PromiseOrValue::Value(refund(
                curator,
                self.enable_cost().0,
                "Only the creator of a settled token can enable Chapters.",
            ));
        }
        if self.registrations.get(&sale_id).is_some() {
            return PromiseOrValue::Value(refund(
                curator,
                self.enable_cost().0,
                "Chapters already exist for this sale.",
            ));
        }

        let contract_id = escrow_account(&sale_id);
        self.registrations.insert(
            sale_id.clone(),
            Registration {
                phase: Phase::Deploying,
                contract_id: contract_id.clone(),
                curator: curator.clone(),
                token_id: sale.token.clone(),
                quote_token_id: sale.quote_token.clone(),
                title,
                brief,
            },
        );

        // The single action batch creates and initializes the child atomically.
        // When it fails the chain refunds its transfer to the creator.
        Promise::new(contract_id)
            .refund_to(curator)
            .create_account()
            .transfer(storage_cost(CHILD_BYTES))
            .use_global_contract(self.chapters_code_hash)
            .function_call(
                "new_from_factory",
                json_bytes(json!({ "curator": sale.creator, "token_id": sale.token, "quote_token_id": sale.quote_token })),
                NearToken::from_yoctonear(0),
                INIT_GAS,
            )
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_escrow_created",
                    json_bytes(json!({ "sale_id": sale_id })),
                    NearToken::from_yoctonear(0),
                    DONE_GAS,
                ),
            )
            .into()
    }

    #[private]
    pub fn on_escrow_created(&mut self, sale_id: String) -> EnableResult {
        require!(
            env::promise_results_count() == 1,
            "Expected one escrow receipt"
        );
        let registration = self
            .registrations
            .get_mut(&sale_id)
            .expect("Escrow deployment was not requested");
        require!(
            registration.phase == Phase::Deploying,
            "The escrow is already enabled"
        );
        // The initializer returns no bytes. The runtime records the completed action batch.
        if env::promise_result_checked(0, 0).is_ok() {
            registration.phase = Phase::Enabled;
            return EnableResult {
                enabled: true,
                error: None,
            };
        }
        let curator = registration.curator.clone();
        self.registrations.remove(&sale_id);
        refund(
            curator,
            storage_cost(REGISTRY_BYTES).as_yoctonear(),
            "The escrow could not be created. Try again.",
        )
    }
}

fn json_bytes(value: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&value).expect("Factory JSON must serialize")
}

fn refund(curator: AccountId, yoctonear: u128, error: &'static str) -> EnableResult {
    Promise::new(curator)
        .transfer(NearToken::from_yoctonear(yoctonear))
        .detach();
    EnableResult {
        enabled: false,
        error: Some(error),
    }
}

fn storage_cost(bytes: u128) -> NearToken {
    NearToken::from_yoctonear(bytes * env::storage_byte_cost().as_yoctonear())
}

fn escrow_account(sale_id: &str) -> AccountId {
    let digest = env::sha256_array(sale_id.as_bytes());
    let label = digest[..15]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("c{label}.{}", env::current_account_id())
        .parse()
        .expect("Valid factory child account")
}

fn valid_text(value: &str, limit: usize) -> bool {
    value.len() <= limit && !value.trim().is_empty()
}

fn valid_sale_id(sale_id: &str) -> bool {
    let bytes = sale_id.as_bytes();
    let alnum = |byte: &u8| byte.is_ascii_lowercase() || byte.is_ascii_digit();
    !bytes.is_empty()
        && bytes.len() <= 32
        && alnum(&bytes[0])
        && alnum(&bytes[bytes.len() - 1])
        && bytes
            .iter()
            .all(|byte| alnum(byte) || *byte == b'-' || *byte == b'_')
}

fn parse_hash(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let mut result = [0; 32];
    for (index, byte) in result.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(result)
}
