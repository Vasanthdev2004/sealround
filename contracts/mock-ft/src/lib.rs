//! Test-only NEP-141 token with an open `mint`. Integration tests use it as USDC
//! (6 decimals by default). Never deploy it anywhere real: anyone can mint.
//!
//! Standards: NEP-141 (core), NEP-145 (storage management) and NEP-148 (metadata).

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FT_METADATA_SPEC, FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::store::Lazy;
use near_sdk::{
    AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue, near, require,
};

/// USDC's decimals, used when `new` is not given any.
pub const DEFAULT_DECIMALS: u8 = 6;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Accounts,
    Metadata,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockFt {
    token: FungibleToken,
    metadata: Lazy<FungibleTokenMetadata>,
}

#[near]
impl MockFt {
    /// Creates an empty token. `decimals` defaults to 6, like USDC.
    #[init]
    pub fn new(name: String, symbol: String, decimals: Option<u8>) -> Self {
        let decimals = decimals.unwrap_or(DEFAULT_DECIMALS);
        require!(decimals <= 24, "decimals must be at most 24");
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name,
            symbol,
            icon: None,
            reference: None,
            reference_hash: None,
            decimals,
        };
        Self {
            token: FungibleToken::new(StorageKey::Accounts),
            metadata: Lazy::new(StorageKey::Metadata, metadata),
        }
    }

    /// Mints `amount` to `account_id`; open to anyone. Registers the account first
    /// if needed, with storage paid from this contract's balance, so tests can
    /// fund any account in one call.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(amount.0 > 0, "The amount should be a positive number");
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);
        FtMint {
            owner_id: &account_id,
            amount,
            memo: None,
        }
        .emit();
    }
}

#[near]
impl FungibleTokenCore for MockFt {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for MockFt {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, _burned) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for MockFt {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.storage_unregister(force)
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for MockFt {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, accounts, get_logs};
    use near_sdk::{env, testing_env};

    const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

    fn call_as(caller: &AccountId, deposit: NearToken) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id("usdc.near".parse().unwrap())
                .signer_account_id(caller.clone())
                .predecessor_account_id(caller.clone())
                .storage_usage(env::storage_usage())
                .attached_deposit(deposit)
                .build()
        );
    }

    fn usdc() -> MockFt {
        call_as(&accounts(0), NearToken::from_near(0));
        MockFt::new("USD Coin".into(), "USDC".into(), None)
    }

    #[test]
    fn new_defaults_to_six_decimals() {
        let token = usdc();
        let metadata = token.ft_metadata();
        assert_eq!(metadata.spec, FT_METADATA_SPEC);
        assert_eq!(metadata.name, "USD Coin");
        assert_eq!(metadata.symbol, "USDC");
        assert_eq!(metadata.decimals, DEFAULT_DECIMALS);
        assert_eq!(token.ft_total_supply().0, 0);
    }

    #[test]
    fn new_takes_explicit_decimals() {
        call_as(&accounts(0), NearToken::from_near(0));
        let token = MockFt::new("Wrapped NEAR".into(), "wNEAR".into(), Some(24));
        assert_eq!(token.ft_metadata().decimals, 24);
    }

    #[test]
    #[should_panic(expected = "decimals must be at most 24")]
    fn new_rejects_too_many_decimals() {
        call_as(&accounts(0), NearToken::from_near(0));
        MockFt::new("Bad".into(), "BAD".into(), Some(25));
    }

    #[test]
    fn mint_registers_and_credits_any_account() {
        let mut token = usdc();
        call_as(&accounts(1), NearToken::from_near(0));
        token.mint(accounts(2), U128(5_000_000));
        token.mint(accounts(2), U128(1_000_000));

        assert!(token.storage_balance_of(accounts(2)).is_some());
        assert_eq!(token.ft_balance_of(accounts(2)).0, 6_000_000);
        assert_eq!(token.ft_total_supply().0, 6_000_000);
        assert_eq!(
            get_logs()[0],
            r#"EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_mint","data":[{"owner_id":"charlie","amount":"5000000"}]}"#
        );
    }

    #[test]
    #[should_panic(expected = "The amount should be a positive number")]
    fn mint_rejects_zero() {
        let mut token = usdc();
        token.mint(accounts(2), U128(0));
    }

    #[test]
    fn minted_tokens_transfer_to_registered_accounts() {
        let mut token = usdc();
        token.mint(accounts(1), U128(10_000_000));
        call_as(&accounts(2), token.storage_balance_bounds().min);
        token.storage_deposit(None, None);

        call_as(&accounts(1), ONE_YOCTO);
        token.ft_transfer(accounts(2), U128(4_000_000), None);

        assert_eq!(token.ft_balance_of(accounts(1)).0, 6_000_000);
        assert_eq!(token.ft_balance_of(accounts(2)).0, 4_000_000);
    }

    #[test]
    fn transfer_call_debits_sender_before_the_receiver_runs() {
        let mut token = usdc();
        token.mint(accounts(1), U128(10_000_000));
        token.mint(accounts(3), U128(1));

        call_as(&accounts(1), ONE_YOCTO);
        let _ = token.ft_transfer_call(accounts(3), U128(5_000_000), None, "{}".into());

        assert_eq!(token.ft_balance_of(accounts(1)).0, 5_000_000);
        assert_eq!(token.ft_balance_of(accounts(3)).0, 5_000_001);
    }
}
