use near_sdk::mock::MockAction;
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts};
use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};

use super::*;

const FACTORY: &str = "chapters-factory.test.near";
const CREATOR: &str = "creator.test.near";
const VIEWER: &str = "viewer.test.near";
const SALE_CONTRACT: &str = "fairground.test.near";
const SALE: &str = "fairt";
const TITLE: &str = "Fair Test story";
const BRIEF: &str = "Show the opening scene of Fair Test.";

fn id(value: &str) -> AccountId {
    value.parse().unwrap()
}

fn context(caller: &str, deposit: u128) -> VMContextBuilder {
    let mut ctx = VMContextBuilder::new();
    ctx.current_account_id(id(FACTORY))
        .signer_account_id(id(caller))
        .predecessor_account_id(id(caller))
        .prepaid_gas(ENABLE_GAS)
        .attached_deposit(NearToken::from_yoctonear(deposit));
    ctx
}

fn factory() -> ChaptersFactory {
    testing_env!(context(FACTORY, 0).build());
    ChaptersFactory::new(id(SALE_CONTRACT), "27".repeat(32))
}

fn callback(result: PromiseResult) {
    testing_env!(
        context(FACTORY, 0).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
}

fn sale_snapshot(sale_id: &str, status: &str) -> PromiseResult {
    PromiseResult::Successful(json_bytes(json!({
        "sale_id": sale_id,
        "status": status,
        "creator": CREATOR,
        "token": format!("{sale_id}.{SALE_CONTRACT}"),
        "quote_token": "usd.test.near",
        "liquidity": null,
    })))
}

fn authenticate(factory: &mut ChaptersFactory, curator: &str) -> PromiseOrValue<EnableResult> {
    factory.on_sale_checked(
        SALE.to_owned(),
        id(curator),
        TITLE.to_owned(),
        BRIEF.to_owned(),
    )
}

fn assert_refund(recipient: &str, expected: u128) {
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].receiver_id, id(recipient));
    assert!(
        matches!(receipts[0].actions.as_slice(), [MockAction::Transfer { deposit, .. }] if deposit.as_yoctonear() == expected)
    );
}

#[test]
fn reads_the_pinned_sale_before_reserving_a_registry_entry() {
    let mut factory = factory();
    testing_env!(context(CREATOR, factory.enable_cost().0).build());
    factory
        .enable_chapters(SALE.to_owned(), TITLE.to_owned(), BRIEF.to_owned())
        .detach();
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].receiver_id, id(SALE_CONTRACT));
    let [
        MockAction::FunctionCallWeight {
            method_name, args, ..
        },
    ] = receipts[0].actions.as_slice()
    else {
        panic!("Expected a view call to the sale contract")
    };
    assert_eq!(method_name, b"get_sale");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(args).unwrap(),
        json!({ "sale_id": SALE })
    );
    assert!(factory.get_chapters(SALE.to_owned()).is_none());
}

#[test]
fn rejects_unsettled_sales_and_wrong_signers_with_a_full_storage_refund() {
    let mut factory = factory();
    for (snapshot, signer) in [
        (sale_snapshot(SALE, "settled"), VIEWER),
        (sale_snapshot(SALE, "open"), CREATOR),
        (sale_snapshot("different", "settled"), CREATOR),
        (PromiseResult::Failed, CREATOR),
    ] {
        callback(snapshot);
        let outcome = authenticate(&mut factory, signer);
        assert!(matches!(
            outcome,
            PromiseOrValue::Value(EnableResult { enabled: false, .. })
        ));
        assert_refund(signer, factory.enable_cost().0);
        assert!(factory.get_chapters(SALE.to_owned()).is_none());
    }
}

#[test]
fn creates_one_keyless_escrow_with_immutable_story_and_sale_terms() {
    let mut factory = factory();
    callback(sale_snapshot(SALE, "settled"));
    assert!(matches!(
        authenticate(&mut factory, CREATOR),
        PromiseOrValue::Promise(_)
    ));
    let escrow = escrow_account(SALE);
    assert_ne!(escrow, escrow_account("fairt-2"));
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].receiver_id, escrow);
    let [
        MockAction::SetRefundTo {
            refund_to_account_id,
            ..
        },
        MockAction::CreateAccount { .. },
        MockAction::Transfer { deposit, .. },
        MockAction::UseGlobalContract { .. },
        MockAction::FunctionCallWeight {
            method_name, args, ..
        },
    ] = receipts[0].actions.as_slice()
    else {
        panic!("Expected a single batch with no access key")
    };
    assert_eq!(refund_to_account_id.as_str(), CREATOR);
    assert_eq!(*deposit, storage_cost(CHILD_BYTES));
    assert_eq!(method_name, b"new_from_factory");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(args).unwrap(),
        json!({
            "curator": CREATOR, "token_id": "fairt.fairground.test.near", "quote_token_id": "usd.test.near"
        })
    );

    callback(sale_snapshot(SALE, "settled"));
    assert!(matches!(
        authenticate(&mut factory, CREATOR),
        PromiseOrValue::Value(EnableResult { enabled: false, .. })
    ));
    assert_refund(CREATOR, factory.enable_cost().0);
    assert_eq!(
        factory.get_chapters(SALE.to_owned()).unwrap().phase,
        Phase::Deploying
    );

    callback(PromiseResult::Successful(Vec::new()));
    assert!(factory.on_escrow_created(SALE.to_owned()).enabled);
    let enabled = factory.get_chapters(SALE.to_owned()).unwrap();
    assert_eq!(enabled.phase, Phase::Enabled);
    assert_eq!(enabled.contract_id, escrow);
    assert_eq!(enabled.title, TITLE);
    assert_eq!(enabled.brief, BRIEF);
}

#[test]
fn releases_a_failed_deployment_for_retry() {
    let mut factory = factory();
    callback(sale_snapshot(SALE, "settled"));
    authenticate(&mut factory, CREATOR).detach();

    callback(PromiseResult::Failed);
    assert!(!factory.on_escrow_created(SALE.to_owned()).enabled);
    // The failed child batch itself returns that child's deposit to the creator.
    assert_refund(CREATOR, storage_cost(REGISTRY_BYTES).as_yoctonear());
    assert!(factory.get_chapters(SALE.to_owned()).is_none());

    callback(sale_snapshot(SALE, "settled"));
    authenticate(&mut factory, CREATOR).detach();
    assert_eq!(
        factory.get_chapters(SALE.to_owned()).unwrap().phase,
        Phase::Deploying
    );
}

#[test]
#[should_panic(expected = "Story title must be 1 to 96 bytes")]
fn bounds_story_by_utf8_bytes() {
    let mut factory = factory();
    testing_env!(context(CREATOR, factory.enable_cost().0).build());
    factory
        .enable_chapters(SALE.to_owned(), "誕".repeat(33), BRIEF.to_owned())
        .detach();
}
