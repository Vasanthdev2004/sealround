//! Fairground sale token: a fixed-supply NEP-141 fungible token.
//!
//! Fairground deploys one of these per sale, to `<sale_id>.<fairground account>`.
//! `new` mints the whole supply to the Fairground contract, once. There is no
//! mint, owner, admin or upgrade method, so the supply can only fall: any holder
//! may burn its own balance, which is how Fairground destroys unsold tokens.
//!
//! Standards: NEP-141 (core), NEP-145 (storage management) and NEP-148
//! (metadata), with the NEP-297 `ft_mint`, `ft_transfer` and `ft_burn` events.

use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
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
    AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue, assert_one_yocto, env,
    near, require,
};

/// Largest accepted `decimals`. Same bound as the Fairground sale parameters; it
/// keeps one whole token (`10^decimals`) far inside u128.
pub const MAX_DECIMALS: u8 = 24;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Accounts,
    Metadata,
}

/// NEP-330 metadata lists the standards so explorers and wallets can discover them;
/// version and link come from cargo-near at build time.
#[near(
    contract_state,
    contract_metadata(
        standard(standard = "nep141", version = "1.0.0"),
        standard(standard = "nep145", version = "1.0.0"),
        standard(standard = "nep148", version = "1.0.0"),
    )
)]
#[derive(PanicOnDefault)]
pub struct FairgroundToken {
    token: FungibleToken,
    /// Fixed at `new`. Kept in its own storage slot so transfers never load the icon.
    metadata: Lazy<FungibleTokenMetadata>,
}

#[near]
impl FairgroundToken {
    /// Creates the token and mints `total_supply` to `owner_id` (the Fairground
    /// contract). `#[init]` refuses to run on existing state, so this is the only
    /// mint the token will ever see.
    #[init]
    pub fn new(owner_id: AccountId, total_supply: U128, metadata: FungibleTokenMetadata) -> Self {
        if let Err(reason) = validate_metadata(&metadata) {
            env::panic_str(reason);
        }
        require!(total_supply.0 > 0, "total_supply must be positive");

        let mut token = FungibleToken::new(StorageKey::Accounts);
        token.internal_register_account(&owner_id);
        token.internal_deposit(&owner_id, total_supply.0);
        FtMint {
            owner_id: &owner_id,
            amount: total_supply,
            memo: Some("initial supply"),
        }
        .emit();

        Self {
            token,
            metadata: Lazy::new(StorageKey::Metadata, metadata),
        }
    }

    /// Burns `amount` of the caller's own balance; the total supply falls by the
    /// same amount. Requires exactly 1 yoctoNEAR, like `ft_transfer`, so a
    /// function-call access key cannot burn on the holder's behalf.
    #[payable]
    pub fn burn(&mut self, amount: U128) {
        assert_one_yocto();
        let owner_id = env::predecessor_account_id();
        require!(amount.0 > 0, "The amount should be a positive number");
        let balance = self.token.accounts.get(&owner_id).unwrap_or(0);
        require!(
            amount.0 <= balance,
            "The account doesn't have enough balance"
        );

        self.token.internal_withdraw(&owner_id, amount.0);
        FtBurn {
            owner_id: &owner_id,
            amount,
            memo: None,
        }
        .emit();
    }
}

#[near]
impl FungibleTokenCore for FairgroundToken {
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
impl FungibleTokenResolver for FairgroundToken {
    /// Returns the amount the receiver kept. If the sender unregistered while the
    /// transfer was in flight, the standard burns the refund and emits `ft_burn`.
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
impl StorageManagement for FairgroundToken {
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

    /// With `force: true` a holder may leave with a positive balance. That balance
    /// is destroyed and the supply falls, so it is reported as an `ft_burn`.
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        let Some((account_id, balance)) = self.token.internal_storage_unregister(force) else {
            return false;
        };
        if balance > 0 {
            FtBurn {
                owner_id: &account_id,
                amount: U128(balance),
                memo: Some("storage_unregister"),
            }
            .emit();
        }
        true
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for FairgroundToken {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().clone()
    }
}

/// Checks NEP-148 metadata before it is stored for good: nothing can change it later.
fn validate_metadata(metadata: &FungibleTokenMetadata) -> Result<(), &'static str> {
    if metadata.spec != FT_METADATA_SPEC {
        return Err("metadata.spec must be \"ft-1.0.0\"");
    }
    if metadata.name.is_empty() {
        return Err("metadata.name must not be empty");
    }
    if metadata.symbol.is_empty() {
        return Err("metadata.symbol must not be empty");
    }
    if metadata.decimals > MAX_DECIMALS {
        return Err("metadata.decimals must be at most 24");
    }
    if metadata.reference.is_some() != metadata.reference_hash.is_some() {
        return Err("metadata.reference and metadata.reference_hash must be set together");
    }
    if let Some(hash) = &metadata.reference_hash
        && hash.0.len() != 32
    {
        return Err("metadata.reference_hash must be 32 bytes");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::json_types::Base64VecU8;
    use near_sdk::test_utils::{VMContextBuilder, accounts, get_logs};
    use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};

    const ONE_TOKEN: u128 = 10u128.pow(18);
    const SUPPLY: u128 = 1_000_000 * ONE_TOKEN;
    /// NEP-145 cost of one holder: 125 bytes at 10^19 yoctoNEAR per byte.
    const REGISTRATION: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
    const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
    const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);

    fn fairground() -> AccountId {
        "fairground.near".parse().unwrap()
    }

    fn alice() -> AccountId {
        accounts(0)
    }

    fn bob() -> AccountId {
        accounts(1)
    }

    /// Makes the next calls come from `caller` with `deposit` attached, keeping
    /// the storage written so far.
    fn call_as(caller: &AccountId, deposit: NearToken) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id("fairt.fairground.near".parse().unwrap())
                .signer_account_id(caller.clone())
                .predecessor_account_id(caller.clone())
                .storage_usage(env::storage_usage())
                .attached_deposit(deposit)
                .build()
        );
    }

    fn metadata() -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Fair Token".to_string(),
            symbol: "FAIRT".to_string(),
            icon: Some("data:image/svg+xml,%3Csvg%3E%3C/svg%3E".to_string()),
            reference: None,
            reference_hash: None,
            decimals: 18,
        }
    }

    /// A token minted to Fairground, with Alice registered and holding 1000 tokens.
    fn token_with_alice() -> FairgroundToken {
        call_as(&fairground(), NO_DEPOSIT);
        let mut token = FairgroundToken::new(fairground(), U128(SUPPLY), metadata());
        call_as(&alice(), REGISTRATION);
        token.storage_deposit(None, None);
        call_as(&fairground(), ONE_YOCTO);
        token.ft_transfer(alice(), U128(1000 * ONE_TOKEN), None);
        token
    }

    fn balance(token: &FairgroundToken, account_id: AccountId) -> u128 {
        token.ft_balance_of(account_id).0
    }

    fn event(kind: &str, data: &str) -> String {
        format!(
            r#"EVENT_JSON:{{"standard":"nep141","version":"1.0.0","event":"{kind}","data":[{data}]}}"#
        )
    }

    #[test]
    fn new_mints_whole_supply_to_owner_once() {
        call_as(&fairground(), NO_DEPOSIT);
        let token = FairgroundToken::new(fairground(), U128(SUPPLY), metadata());

        assert_eq!(token.ft_total_supply().0, SUPPLY);
        assert_eq!(balance(&token, fairground()), SUPPLY);
        assert!(token.storage_balance_of(fairground()).is_some());
        assert_eq!(
            get_logs(),
            vec![event(
                "ft_mint",
                &format!(
                    r#"{{"owner_id":"fairground.near","amount":"{SUPPLY}","memo":"initial supply"}}"#
                ),
            )]
        );
    }

    #[test]
    fn new_accepts_decimals_from_0_to_24() {
        for decimals in [0, 6, 18, MAX_DECIMALS] {
            let metadata = FungibleTokenMetadata {
                decimals,
                ..metadata()
            };
            assert_eq!(validate_metadata(&metadata), Ok(()));
        }
    }

    #[test]
    fn validate_metadata_rejects_bad_fields() {
        let cases = [
            (
                FungibleTokenMetadata {
                    spec: "ft-2.0.0".into(),
                    ..metadata()
                },
                "metadata.spec",
            ),
            (
                FungibleTokenMetadata {
                    name: String::new(),
                    ..metadata()
                },
                "metadata.name",
            ),
            (
                FungibleTokenMetadata {
                    symbol: String::new(),
                    ..metadata()
                },
                "metadata.symbol",
            ),
            (
                FungibleTokenMetadata {
                    decimals: 25,
                    ..metadata()
                },
                "metadata.decimals",
            ),
            (
                FungibleTokenMetadata {
                    reference: Some("https://x".into()),
                    ..metadata()
                },
                "metadata.reference and",
            ),
            (
                FungibleTokenMetadata {
                    reference: Some("https://x".into()),
                    reference_hash: Some(Base64VecU8(vec![0; 31])),
                    ..metadata()
                },
                "metadata.reference_hash must be 32",
            ),
        ];
        for (metadata, expected) in cases {
            let err = validate_metadata(&metadata).unwrap_err();
            assert!(
                err.starts_with(expected),
                "{err:?} should start with {expected:?}"
            );
        }
        let with_reference = FungibleTokenMetadata {
            reference: Some("https://x".into()),
            reference_hash: Some(Base64VecU8(vec![0; 32])),
            ..metadata()
        };
        assert_eq!(validate_metadata(&with_reference), Ok(()));
    }

    #[test]
    #[should_panic(expected = "metadata.decimals must be at most 24")]
    fn new_rejects_too_many_decimals() {
        call_as(&fairground(), NO_DEPOSIT);
        FairgroundToken::new(
            fairground(),
            U128(SUPPLY),
            FungibleTokenMetadata {
                decimals: 25,
                ..metadata()
            },
        );
    }

    #[test]
    #[should_panic(expected = "metadata.spec must be")]
    fn new_rejects_wrong_spec() {
        call_as(&fairground(), NO_DEPOSIT);
        FairgroundToken::new(
            fairground(),
            U128(SUPPLY),
            FungibleTokenMetadata {
                spec: "ft-0.1.0".into(),
                ..metadata()
            },
        );
    }

    #[test]
    #[should_panic(expected = "total_supply must be positive")]
    fn new_rejects_zero_supply() {
        call_as(&fairground(), NO_DEPOSIT);
        FairgroundToken::new(fairground(), U128(0), metadata());
    }

    #[test]
    fn ft_metadata_returns_init_metadata() {
        let token = token_with_alice();
        let stored = token.ft_metadata();
        let expected = metadata();
        assert_eq!(stored.spec, expected.spec);
        assert_eq!(stored.name, expected.name);
        assert_eq!(stored.symbol, expected.symbol);
        assert_eq!(stored.icon, expected.icon);
        assert_eq!(stored.decimals, expected.decimals);
        assert!(stored.reference.is_none() && stored.reference_hash.is_none());
    }

    #[test]
    fn transfer_moves_balance_and_emits_event() {
        let mut token = token_with_alice();
        call_as(&bob(), REGISTRATION);
        token.storage_deposit(None, None);

        call_as(&alice(), ONE_YOCTO);
        token.ft_transfer(bob(), U128(250 * ONE_TOKEN), Some("hi".into()));

        assert_eq!(balance(&token, alice()), 750 * ONE_TOKEN);
        assert_eq!(balance(&token, bob()), 250 * ONE_TOKEN);
        assert_eq!(token.ft_total_supply().0, SUPPLY);
        assert_eq!(
            get_logs(),
            vec![event(
                "ft_transfer",
                &format!(
                    r#"{{"old_owner_id":"alice","new_owner_id":"bob","amount":"{}","memo":"hi"}}"#,
                    250 * ONE_TOKEN
                ),
            )]
        );
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn transfer_requires_one_yocto() {
        let mut token = token_with_alice();
        call_as(&alice(), NO_DEPOSIT);
        token.ft_transfer(fairground(), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "The account bob is not registered")]
    fn transfer_to_unregistered_account_fails() {
        let mut token = token_with_alice();
        call_as(&alice(), ONE_YOCTO);
        token.ft_transfer(bob(), U128(1), None);
    }

    #[test]
    fn resolve_transfer_refunds_unused_amount() {
        let mut token = token_with_alice();
        call_as(&alice(), ONE_YOCTO);
        let _ = token.ft_transfer_call(fairground(), U128(100), None, "bid".into());
        assert_eq!(balance(&token, alice()), 1000 * ONE_TOKEN - 100);

        // The receiver says it used none of the 100 tokens.
        testing_env!(
            VMContextBuilder::new()
                .current_account_id("fairt.fairground.near".parse().unwrap())
                .predecessor_account_id("fairt.fairground.near".parse().unwrap())
                .storage_usage(env::storage_usage())
                .build(),
            test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Successful(b"\"100\"".to_vec())],
        );
        let used = token.ft_resolve_transfer(alice(), fairground(), U128(100));

        assert_eq!(used.0, 0);
        assert_eq!(balance(&token, alice()), 1000 * ONE_TOKEN);
        assert_eq!(token.ft_total_supply().0, SUPPLY);
    }

    #[test]
    fn burn_reduces_balance_and_supply_and_emits_event() {
        let mut token = token_with_alice();
        let burned = 400 * ONE_TOKEN;
        call_as(&fairground(), ONE_YOCTO);
        token.burn(U128(burned));

        assert_eq!(
            balance(&token, fairground()),
            SUPPLY - 1000 * ONE_TOKEN - burned
        );
        assert_eq!(token.ft_total_supply().0, SUPPLY - burned);
        assert_eq!(
            get_logs(),
            vec![event(
                "ft_burn",
                &format!(r#"{{"owner_id":"fairground.near","amount":"{burned}"}}"#)
            )]
        );
    }

    #[test]
    fn any_holder_can_burn_its_whole_balance() {
        let mut token = token_with_alice();
        call_as(&alice(), ONE_YOCTO);
        token.burn(U128(1000 * ONE_TOKEN));

        assert_eq!(balance(&token, alice()), 0);
        assert_eq!(balance(&token, fairground()), SUPPLY - 1000 * ONE_TOKEN);
        assert_eq!(token.ft_total_supply().0, SUPPLY - 1000 * ONE_TOKEN);
    }

    #[test]
    #[should_panic(expected = "The amount should be a positive number")]
    fn burn_rejects_zero() {
        let mut token = token_with_alice();
        call_as(&alice(), ONE_YOCTO);
        token.burn(U128(0));
    }

    #[test]
    #[should_panic(expected = "The account doesn't have enough balance")]
    fn burn_rejects_more_than_balance() {
        let mut token = token_with_alice();
        call_as(&alice(), ONE_YOCTO);
        token.burn(U128(1000 * ONE_TOKEN + 1));
    }

    #[test]
    #[should_panic(expected = "The account doesn't have enough balance")]
    fn burn_from_unregistered_account_fails() {
        let mut token = token_with_alice();
        call_as(&bob(), ONE_YOCTO);
        token.burn(U128(1));
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn burn_requires_one_yocto() {
        let mut token = token_with_alice();
        call_as(&alice(), NearToken::from_yoctonear(2));
        token.burn(U128(1));
    }

    #[test]
    fn storage_bounds_cover_one_125_byte_account() {
        let token = token_with_alice();
        let bounds = token.storage_balance_bounds();
        assert_eq!(bounds.min, REGISTRATION);
        assert_eq!(bounds.max, Some(REGISTRATION));
    }

    #[test]
    fn storage_deposit_registers_another_account() {
        let mut token = token_with_alice();
        assert!(token.storage_balance_of(bob()).is_none());

        // Alice pays for Bob, with more than enough attached.
        call_as(&alice(), NearToken::from_near(1));
        let storage = token.storage_deposit(Some(bob()), None);

        assert_eq!(storage.total, REGISTRATION);
        assert_eq!(storage.available, NO_DEPOSIT);
        assert_eq!(balance(&token, bob()), 0);
        assert!(token.storage_balance_of(bob()).is_some());
    }

    #[test]
    #[should_panic(expected = "The attached deposit is less than the minimum storage balance")]
    fn storage_deposit_below_minimum_fails() {
        let mut token = token_with_alice();
        call_as(&bob(), REGISTRATION.saturating_sub(ONE_YOCTO));
        token.storage_deposit(None, None);
    }

    #[test]
    #[should_panic(
        expected = "Can't unregister the account with the positive balance without force"
    )]
    fn storage_unregister_with_balance_needs_force() {
        let mut token = token_with_alice();
        call_as(&alice(), ONE_YOCTO);
        token.storage_unregister(None);
    }

    #[test]
    fn forced_unregister_burns_the_balance() {
        let mut token = token_with_alice();
        call_as(&alice(), ONE_YOCTO);
        assert!(token.storage_unregister(Some(true)));

        assert!(token.storage_balance_of(alice()).is_none());
        assert_eq!(token.ft_total_supply().0, SUPPLY - 1000 * ONE_TOKEN);
        assert_eq!(
            get_logs(),
            vec![event(
                "ft_burn",
                &format!(
                    r#"{{"owner_id":"alice","amount":"{}","memo":"storage_unregister"}}"#,
                    1000 * ONE_TOKEN
                ),
            )]
        );
    }

    #[test]
    fn unregister_of_unknown_account_returns_false() {
        let mut token = token_with_alice();
        call_as(&bob(), ONE_YOCTO);
        assert!(!token.storage_unregister(None));
    }
}
