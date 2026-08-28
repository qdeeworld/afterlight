use afterlight_spike::afterlight::{
    IAfterlightDispatcher, IAfterlightDispatcherTrait, IAfterlightSafeDispatcher,
    IAfterlightSafeDispatcherTrait,
};
use afterlight_spike::common::{
    CANCEL_TAG, CLAIM_TAG, ControlArgs, ExitArgs, FUND_TAG, FundArgs, HEARTBEAT_TAG, MODE_FAST_DEMO,
    MODE_NORMAL, PrivateAction, REQUEST_TAG, STATE_ACTIVE, STATE_CANCELLED, STATE_CLAIMED,
    STATE_GRACE, STATE_UNSET, VETO_TAG, message_hash,
};
use afterlight_spike::mocks::{
    IMockERC20Dispatcher, IMockERC20DispatcherTrait, IMockPrivacyPoolDispatcher,
    IMockPrivacyPoolDispatcherTrait, IMockPrivacyPoolSafeDispatcher,
    IMockPrivacyPoolSafeDispatcherTrait,
};
use snforge_std::signature::KeyPairTrait;
use snforge_std::signature::stark_curve::{StarkCurveKeyPairImpl, StarkCurveSignerImpl};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp,
    start_cheat_caller_address, start_cheat_chain_id, stop_cheat_caller_address,
};
use starknet::ContractAddress;

const START: u64 = 1_000;
const FAST_INACTIVITY: u64 = 10;
const FAST_GRACE: u64 = 5;
const NORMAL_MIN_INACTIVITY: u64 = 100;
const NORMAL_MIN_GRACE: u64 = 50;
const MAX_INTERVAL: u64 = 1_000;
const MAX_AUTH_WINDOW: u64 = 100;
const MAX_FUNDING_CHECKPOINT_AGE: u64 = 20;
const AMOUNT: u128 = 1_000;
const TEST_CHAIN_ID: felt252 = 'AFTERLIGHT_TEST';

type Keys = snforge_std::signature::KeyPair<felt252, felt252>;

#[derive(Copy, Drop)]
struct Env {
    pool: IMockPrivacyPoolDispatcher,
    token: IMockERC20Dispatcher,
    app: IAfterlightDispatcher,
}

fn deploy_env() -> Env {
    let (pool_addr, _) = declare("MockPrivacyPool")
        .unwrap()
        .contract_class()
        .deploy(@array![])
        .unwrap();
    let (token_addr, _) = declare("MockERC20").unwrap().contract_class().deploy(@array![]).unwrap();
    let (app_addr, _) = declare("Afterlight")
        .unwrap()
        .contract_class()
        .deploy(
            @array![
                pool_addr.into(), token_addr.into(), AMOUNT.into(), NORMAL_MIN_INACTIVITY.into(),
                NORMAL_MIN_GRACE.into(), FAST_INACTIVITY.into(), FAST_GRACE.into(),
                MAX_INTERVAL.into(), MAX_AUTH_WINDOW.into(), MAX_FUNDING_CHECKPOINT_AGE.into(),
            ],
        )
        .unwrap();
    let env = Env {
        pool: IMockPrivacyPoolDispatcher { contract_address: pool_addr },
        token: IMockERC20Dispatcher { contract_address: token_addr },
        app: IAfterlightDispatcher { contract_address: app_addr },
    };
    start_cheat_chain_id(env.app.contract_address, TEST_CHAIN_ID);
    set_time(env, START);
    env
}

fn deploy_second_app(env: Env) -> IAfterlightDispatcher {
    let (app_addr, _) = declare("Afterlight")
        .unwrap()
        .contract_class()
        .deploy(
            @array![
                env.pool.contract_address.into(), env.token.contract_address.into(), AMOUNT.into(),
                NORMAL_MIN_INACTIVITY.into(), NORMAL_MIN_GRACE.into(), FAST_INACTIVITY.into(),
                FAST_GRACE.into(), MAX_INTERVAL.into(), MAX_AUTH_WINDOW.into(),
                MAX_FUNDING_CHECKPOINT_AGE.into(),
            ],
        )
        .unwrap();
    start_cheat_chain_id(app_addr, TEST_CHAIN_ID);
    start_cheat_block_timestamp(app_addr, START);
    IAfterlightDispatcher { contract_address: app_addr }
}

fn set_time(env: Env, timestamp: u64) {
    start_cheat_block_timestamp(env.app.contract_address, timestamp);
}

fn fresh_keys() -> (Keys, Keys) {
    (KeyPairTrait::<felt252, felt252>::generate(), KeyPairTrait::<felt252, felt252>::generate())
}

fn base_fund(
    env: Env, vault_id: felt252, owner: Keys, successor: Keys, valid_until: u64,
) -> FundArgs {
    FundArgs {
        vault_id,
        token: env.token.contract_address,
        amount: AMOUNT,
        mode: MODE_FAST_DEMO,
        owner_key: owner.public_key,
        successor_key: successor.public_key,
        inactivity_seconds: FAST_INACTIVITY,
        grace_seconds: FAST_GRACE,
        valid_until,
        sig_r: 0,
        sig_s: 0,
    }
}

fn sign_fund(env: Env, args: FundArgs, owner: Keys) -> FundArgs {
    let hash = message_hash(
        FUND_TAG,
        TEST_CHAIN_ID,
        env.app.contract_address,
        args.vault_id,
        args.token,
        args.amount,
        STATE_UNSET,
        0,
        0,
        args.owner_key,
        0,
        args.valid_until,
        array![
            args.mode.into(), args.successor_key, args.inactivity_seconds.into(),
            args.grace_seconds.into(),
        ]
            .span(),
    );
    let (sig_r, sig_s) = owner.sign(hash).unwrap();
    FundArgs { sig_r, sig_s, ..args }
}

fn invoke_private(env: Env, action: PrivateAction, expected_deposits: u32) {
    let mut calldata = array![];
    action.serialize(ref calldata);
    env.pool.invoke_external(env.app.contract_address, calldata.span(), expected_deposits);
}

#[feature("safe_dispatcher")]
fn safe_invoke_private(
    env: Env, action: PrivateAction, expected_deposits: u32,
) -> Result<(), Array<felt252>> {
    let mut calldata = array![];
    action.serialize(ref calldata);
    IMockPrivacyPoolSafeDispatcher { contract_address: env.pool.contract_address }
        .invoke_external(env.app.contract_address, calldata.span(), expected_deposits)
}

fn fund_vault(env: Env, vault_id: felt252, owner: Keys, successor: Keys) {
    env.app.sync_funding_checkpoint();
    env.token.mint(env.app.contract_address, AMOUNT.into());
    let args = sign_fund(env, base_fund(env, vault_id, owner, successor, START + 50), owner);
    invoke_private(env, PrivateAction::Fund(args), 0);
}

fn base_control(
    env: Env,
    vault_id: felt252,
    expected_state: u8,
    expected_epoch: u64,
    expected_nonce: u64,
    valid_until: u64,
) -> ControlArgs {
    ControlArgs {
        vault_id,
        token: env.token.contract_address,
        amount: AMOUNT,
        expected_state,
        expected_epoch,
        expected_nonce,
        valid_until,
        sig_r: 0,
        sig_s: 0,
    }
}

fn sign_heartbeat(env: Env, auth: ControlArgs, owner: Keys) -> ControlArgs {
    let vault = env.app.get_vault(auth.vault_id);
    let (sig_r, sig_s) = owner
        .sign(
            message_hash(
                HEARTBEAT_TAG,
                TEST_CHAIN_ID,
                env.app.contract_address,
                auth.vault_id,
                auth.token,
                auth.amount,
                auth.expected_state,
                auth.expected_epoch,
                auth.expected_nonce,
                vault.owner_key,
                0,
                auth.valid_until,
                array![vault.last_heartbeat.into()].span(),
            ),
        )
        .unwrap();
    ControlArgs { sig_r, sig_s, ..auth }
}

fn sign_request(env: Env, auth: ControlArgs, successor: Keys) -> ControlArgs {
    let vault = env.app.get_vault(auth.vault_id);
    let (sig_r, sig_s) = successor
        .sign(
            message_hash(
                REQUEST_TAG,
                TEST_CHAIN_ID,
                env.app.contract_address,
                auth.vault_id,
                auth.token,
                auth.amount,
                auth.expected_state,
                auth.expected_epoch,
                auth.expected_nonce,
                vault.successor_key,
                0,
                auth.valid_until,
                array![vault.last_heartbeat.into()].span(),
            ),
        )
        .unwrap();
    ControlArgs { sig_r, sig_s, ..auth }
}

fn sign_veto(env: Env, auth: ControlArgs, owner: Keys) -> ControlArgs {
    let vault = env.app.get_vault(auth.vault_id);
    let (sig_r, sig_s) = owner
        .sign(
            message_hash(
                VETO_TAG,
                TEST_CHAIN_ID,
                env.app.contract_address,
                auth.vault_id,
                auth.token,
                auth.amount,
                auth.expected_state,
                auth.expected_epoch,
                auth.expected_nonce,
                vault.owner_key,
                0,
                auth.valid_until,
                array![vault.requested_at.into(), vault.claim_after.into()].span(),
            ),
        )
        .unwrap();
    ControlArgs { sig_r, sig_s, ..auth }
}

fn base_exit(
    env: Env,
    vault_id: felt252,
    expected_state: u8,
    expected_epoch: u64,
    expected_nonce: u64,
    note_id: felt252,
    valid_until: u64,
) -> ExitArgs {
    ExitArgs {
        vault_id,
        token: env.token.contract_address,
        amount: AMOUNT,
        expected_state,
        expected_epoch,
        expected_nonce,
        note_id,
        valid_until,
        sig_r: 0,
        sig_s: 0,
    }
}

fn sign_cancel(env: Env, args: ExitArgs, owner: Keys) -> ExitArgs {
    let vault = env.app.get_vault(args.vault_id);
    let (sig_r, sig_s) = owner
        .sign(
            message_hash(
                CANCEL_TAG,
                TEST_CHAIN_ID,
                env.app.contract_address,
                args.vault_id,
                args.token,
                args.amount,
                args.expected_state,
                args.expected_epoch,
                args.expected_nonce,
                vault.owner_key,
                args.note_id,
                args.valid_until,
                array![].span(),
            ),
        )
        .unwrap();
    ExitArgs { sig_r, sig_s, ..args }
}

fn sign_claim(env: Env, args: ExitArgs, successor: Keys) -> ExitArgs {
    let vault = env.app.get_vault(args.vault_id);
    let (sig_r, sig_s) = successor
        .sign(
            message_hash(
                CLAIM_TAG,
                TEST_CHAIN_ID,
                env.app.contract_address,
                args.vault_id,
                args.token,
                args.amount,
                args.expected_state,
                args.expected_epoch,
                args.expected_nonce,
                vault.successor_key,
                args.note_id,
                args.valid_until,
                array![vault.requested_at.into(), vault.claim_after.into()].span(),
            ),
        )
        .unwrap();
    ExitArgs { sig_r, sig_s, ..args }
}

fn request_at_boundary(env: Env, vault_id: felt252, successor: Keys, epoch: u64, nonce: u64) {
    let vault = env.app.get_vault(vault_id);
    set_time(env, vault.last_heartbeat + FAST_INACTIVITY);
    let auth = sign_request(
        env,
        base_control(
            env, vault_id, STATE_ACTIVE, epoch, nonce, vault.last_heartbeat + FAST_INACTIVITY + 50,
        ),
        successor,
    );
    env.app.request_recovery(auth);
}

fn prepare_claimable(env: Env, vault_id: felt252, owner: Keys, successor: Keys) {
    fund_vault(env, vault_id, owner, successor);
    request_at_boundary(env, vault_id, successor, 1, 0);
}

#[test]
fn full_recovery_lifecycle_enforces_boundaries_and_exact_note() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault-b', owner, successor);
    assert(env.app.get_locked_by_token(env.token.contract_address) == AMOUNT.into(), 'lock');

    set_time(env, START + 5);
    let heartbeat = sign_heartbeat(
        env, base_control(env, 'vault-b', STATE_ACTIVE, 1, 1, START + 55), owner,
    );
    let relayer_a: ContractAddress = 'relayer-a'.try_into().unwrap();
    start_cheat_caller_address(env.app.contract_address, relayer_a);
    env.app.heartbeat(heartbeat);
    stop_cheat_caller_address(env.app.contract_address);
    assert(env.app.get_vault('vault-b').last_heartbeat == START + 5, 'heartbeat');

    request_at_boundary(env, 'vault-b', successor, 1, 0);
    let grace = env.app.get_vault('vault-b');
    assert(grace.state == STATE_GRACE, 'not grace');
    assert(grace.claim_after == START + 20, 'claim time');

    set_time(env, grace.claim_after);
    let veto = sign_veto(
        env, base_control(env, 'vault-b', STATE_GRACE, 1, 2, grace.claim_after + 50), owner,
    );
    let relayer_b: ContractAddress = 'relayer-b'.try_into().unwrap();
    start_cheat_caller_address(env.app.contract_address, relayer_b);
    env.app.veto(veto);
    stop_cheat_caller_address(env.app.contract_address);
    let active = env.app.get_vault('vault-b');
    assert(active.state == STATE_ACTIVE, 'veto state');
    assert(active.epoch == 2, 'veto epoch');
    assert(active.last_heartbeat == START + 20, 'veto timer');

    request_at_boundary(env, 'vault-b', successor, 2, 1);
    let second_grace = env.app.get_vault('vault-b');
    set_time(env, second_grace.claim_after);
    env.pool.create_open_note('successor-note', env.token.contract_address);
    let claim = sign_claim(
        env,
        base_exit(
            env, 'vault-b', STATE_GRACE, 2, 2, 'successor-note', second_grace.claim_after + 50,
        ),
        successor,
    );
    invoke_private(env, PrivateAction::Claim(claim), 1);

    let claimed = env.app.get_vault('vault-b');
    assert(claimed.state == STATE_CLAIMED, 'not claimed');
    assert(claimed.successor_nonce == 3, 'claim nonce');
    assert(env.pool.note_amount('successor-note') == AMOUNT, 'note amount');
    assert(env.app.get_locked_by_token(env.token.contract_address) == 0, 'lock remains');
}

#[test]
fn cancellation_returns_private_open_note_and_reduces_liability() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault-a', owner, successor);
    env.pool.create_open_note('owner-refund', env.token.contract_address);
    let cancel = sign_cancel(
        env, base_exit(env, 'vault-a', STATE_ACTIVE, 1, 1, 'owner-refund', START + 50), owner,
    );
    invoke_private(env, PrivateAction::CancelRefund(cancel), 1);
    assert(env.app.get_vault('vault-a').state == STATE_CANCELLED, 'not cancelled');
    assert(env.pool.note_amount('owner-refund') == AMOUNT, 'refund missing');
    assert(env.app.get_locked_by_token(env.token.contract_address) == 0, 'lock remains');
}

#[test]
#[should_panic(expected: 'AL_NOT_POOL')]
fn privacy_invoke_rejects_non_pool_caller() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    let args = sign_fund(env, base_fund(env, 'vault', owner, successor, START + 50), owner);
    env.app.privacy_invoke(PrivateAction::Fund(args));
}

#[test]
#[should_panic(expected: 'AL_NOT_INACTIVE')]
fn recovery_request_one_second_before_boundary_fails() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault', owner, successor);
    set_time(env, START + FAST_INACTIVITY - 1);
    let auth = sign_request(
        env, base_control(env, 'vault', STATE_ACTIVE, 1, 0, START + 50), successor,
    );
    env.app.request_recovery(auth);
}

#[test]
fn recovery_request_at_exact_boundary_succeeds() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault', owner, successor);
    request_at_boundary(env, 'vault', successor, 1, 0);
    let vault = env.app.get_vault('vault');
    assert(vault.state == STATE_GRACE, 'not grace');
    assert(vault.requested_at == START + FAST_INACTIVITY, 'wrong requested_at');
    assert(vault.claim_after == START + FAST_INACTIVITY + FAST_GRACE, 'wrong claim_after');
}

#[test]
#[feature("safe_dispatcher")]
fn heartbeat_at_inactivity_boundary_resets_the_deadline() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault', owner, successor);
    set_time(env, START + FAST_INACTIVITY);
    let heartbeat = sign_heartbeat(
        env, base_control(env, 'vault', STATE_ACTIVE, 1, 1, START + 50), owner,
    );
    env.app.heartbeat(heartbeat);
    assert(env.app.get_vault('vault').last_heartbeat == START + FAST_INACTIVITY, 'not reset');

    set_time(env, START + FAST_INACTIVITY * 2 - 1);
    let early = sign_request(
        env, base_control(env, 'vault', STATE_ACTIVE, 1, 0, START + 50), successor,
    );
    let safe = IAfterlightSafeDispatcher { contract_address: env.app.contract_address };
    match safe.request_recovery(early) {
        Result::Ok(_) => assert(false, 'request ignored reset'),
        Result::Err(_) => {},
    }
    assert(env.app.get_vault('vault').state == STATE_ACTIVE, 'early request changed state');
}

#[test]
fn heartbeat_after_inactivity_boundary_still_restores_owner_control() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault', owner, successor);
    set_time(env, START + FAST_INACTIVITY + 1);
    let heartbeat = sign_heartbeat(
        env, base_control(env, 'vault', STATE_ACTIVE, 1, 1, START + 50), owner,
    );
    env.app.heartbeat(heartbeat);
    let vault = env.app.get_vault('vault');
    assert(vault.state == STATE_ACTIVE, 'state changed');
    assert(vault.last_heartbeat == START + FAST_INACTIVITY + 1, 'late heartbeat not recorded');
    assert(vault.owner_nonce == 2, 'nonce not consumed');
}

#[test]
fn veto_before_claim_after_restores_active_and_resets_epoch() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    prepare_claimable(env, 'vault', owner, successor);
    let grace = env.app.get_vault('vault');
    set_time(env, grace.claim_after - 1);
    let veto = sign_veto(
        env, base_control(env, 'vault', STATE_GRACE, 1, 1, grace.claim_after + 50), owner,
    );
    env.app.veto(veto);
    let active = env.app.get_vault('vault');
    assert(active.state == STATE_ACTIVE, 'not active');
    assert(active.epoch == 2, 'epoch');
    assert(active.last_heartbeat == grace.claim_after - 1, 'timer');
    assert(active.requested_at == 0 && active.claim_after == 0, 'grace data remains');
}

#[test]
#[should_panic(expected: 'AL_CLAIM_TOO_EARLY')]
fn claim_one_second_before_grace_boundary_fails() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    prepare_claimable(env, 'vault', owner, successor);
    let vault = env.app.get_vault('vault');
    set_time(env, vault.claim_after - 1);
    let claim = sign_claim(
        env, base_exit(env, 'vault', STATE_GRACE, 1, 1, 'note', vault.claim_after + 50), successor,
    );
    invoke_private(env, PrivateAction::Claim(claim), 1);
}

#[test]
fn neutral_relayer_callers_are_not_authority() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault', owner, successor);

    set_time(env, START + 1);
    let first = sign_heartbeat(
        env, base_control(env, 'vault', STATE_ACTIVE, 1, 1, START + 50), owner,
    );
    start_cheat_caller_address(env.app.contract_address, 'arbitrary-one'.try_into().unwrap());
    env.app.heartbeat(first);
    stop_cheat_caller_address(env.app.contract_address);

    set_time(env, START + 2);
    let second = sign_heartbeat(
        env, base_control(env, 'vault', STATE_ACTIVE, 1, 2, START + 50), owner,
    );
    start_cheat_caller_address(env.app.contract_address, 'arbitrary-two'.try_into().unwrap());
    env.app.heartbeat(second);
    stop_cheat_caller_address(env.app.contract_address);
    let vault = env.app.get_vault('vault');
    assert(vault.owner_nonce == 3, 'nonces');
    assert(vault.last_heartbeat == START + 2, 'caller influenced state');
}

#[test]
#[should_panic(expected: 'AL_BAD_SIGNATURE')]
fn wrong_owner_key_cannot_heartbeat() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    let attacker = KeyPairTrait::<felt252, felt252>::generate();
    fund_vault(env, 'vault', owner, successor);
    let auth = base_control(env, 'vault', STATE_ACTIVE, 1, 1, START + 50);
    env.app.heartbeat(sign_heartbeat(env, auth, attacker));
}

#[test]
#[should_panic(expected: 'AL_BAD_SIGNATURE')]
fn wrong_successor_key_cannot_request() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    let attacker = KeyPairTrait::<felt252, felt252>::generate();
    fund_vault(env, 'vault', owner, successor);
    set_time(env, START + FAST_INACTIVITY);
    let auth = base_control(env, 'vault', STATE_ACTIVE, 1, 0, START + 50);
    env.app.request_recovery(sign_request(env, auth, attacker));
}

#[test]
#[should_panic(expected: 'AL_BAD_SIGNATURE')]
fn wrong_owner_key_cannot_cancel_to_private_note() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    let attacker = KeyPairTrait::<felt252, felt252>::generate();
    fund_vault(env, 'vault', owner, successor);
    env.pool.create_open_note('refund', env.token.contract_address);
    let args = base_exit(env, 'vault', STATE_ACTIVE, 1, 1, 'refund', START + 50);
    invoke_private(env, PrivateAction::CancelRefund(sign_cancel(env, args, attacker)), 1);
}

#[test]
#[should_panic(expected: 'AL_BAD_SIGNATURE')]
fn wrong_successor_key_cannot_claim() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    let attacker = KeyPairTrait::<felt252, felt252>::generate();
    prepare_claimable(env, 'vault', owner, successor);
    let vault = env.app.get_vault('vault');
    set_time(env, vault.claim_after);
    env.pool.create_open_note('note', env.token.contract_address);
    let args = base_exit(env, 'vault', STATE_GRACE, 1, 1, 'note', vault.claim_after + 50);
    invoke_private(env, PrivateAction::Claim(sign_claim(env, args, attacker)), 1);
}

#[test]
#[should_panic(expected: 'AL_BAD_EXPECTED_STATE')]
fn wrong_expected_state_is_rejected() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault', owner, successor);
    let auth = base_control(env, 'vault', STATE_GRACE, 1, 1, START + 50);
    env.app.heartbeat(sign_heartbeat(env, auth, owner));
}

#[test]
#[should_panic(expected: 'AL_BAD_EPOCH')]
fn wrong_epoch_is_rejected() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault', owner, successor);
    let auth = base_control(env, 'vault', STATE_ACTIVE, 2, 1, START + 50);
    env.app.heartbeat(sign_heartbeat(env, auth, owner));
}

#[test]
#[should_panic(expected: 'AL_BAD_NONCE')]
fn future_nonce_is_rejected() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault', owner, successor);
    let auth = base_control(env, 'vault', STATE_ACTIVE, 1, 2, START + 50);
    env.app.heartbeat(sign_heartbeat(env, auth, owner));
}

#[test]
#[should_panic(expected: 'AL_WRONG_TOKEN')]
fn relayed_action_rejects_wrong_token() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault', owner, successor);
    let (other_token, _) = declare("MockERC20")
        .unwrap()
        .contract_class()
        .deploy(@array![])
        .unwrap();
    let auth = ControlArgs {
        token: other_token, ..base_control(env, 'vault', STATE_ACTIVE, 1, 1, START + 50),
    };
    env.app.heartbeat(sign_heartbeat(env, auth, owner));
}

#[test]
#[should_panic(expected: 'AL_WRONG_AMOUNT')]
fn relayed_action_rejects_wrong_amount() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault', owner, successor);
    let auth = ControlArgs {
        amount: AMOUNT + 1, ..base_control(env, 'vault', STATE_ACTIVE, 1, 1, START + 50),
    };
    env.app.heartbeat(sign_heartbeat(env, auth, owner));
}

#[test]
#[should_panic(expected: 'AL_VAULT_EXISTS')]
fn vault_cannot_be_funded_twice() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault', owner, successor);
    env.token.mint(env.app.contract_address, AMOUNT.into());
    let args = sign_fund(env, base_fund(env, 'vault', owner, successor, START + 50), owner);
    invoke_private(env, PrivateAction::Fund(args), 0);
}

#[test]
#[should_panic(expected: 'AL_KEY_REUSED')]
fn application_key_cannot_be_reused_across_vaults() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault-1', owner, successor);
    let new_successor = KeyPairTrait::<felt252, felt252>::generate();
    env.token.mint(env.app.contract_address, AMOUNT.into());
    let args = sign_fund(env, base_fund(env, 'vault-2', owner, new_successor, START + 50), owner);
    invoke_private(env, PrivateAction::Fund(args), 0);
}

#[test]
#[should_panic(expected: 'AL_SAME_KEY')]
fn owner_and_successor_keys_must_differ() {
    let env = deploy_env();
    let owner = KeyPairTrait::<felt252, felt252>::generate();
    env.token.mint(env.app.contract_address, AMOUNT.into());
    let args = sign_fund(env, base_fund(env, 'vault', owner, owner, START + 50), owner);
    invoke_private(env, PrivateAction::Fund(args), 0);
}

#[test]
#[should_panic(expected: 'AL_ZERO_VAULT')]
fn zero_vault_id_is_rejected() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    env.token.mint(env.app.contract_address, AMOUNT.into());
    let args = sign_fund(env, base_fund(env, 0, owner, successor, START + 50), owner);
    invoke_private(env, PrivateAction::Fund(args), 0);
}

#[test]
#[should_panic(expected: 'AL_ZERO_KEY')]
fn zero_application_key_is_rejected() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    env.token.mint(env.app.contract_address, AMOUNT.into());
    let unsigned = FundArgs {
        successor_key: 0, ..base_fund(env, 'vault', owner, successor, START + 50),
    };
    let args = sign_fund(env, unsigned, owner);
    invoke_private(env, PrivateAction::Fund(args), 0);
}

#[test]
#[should_panic(expected: 'AL_BAD_MODE')]
fn unsupported_mode_is_rejected() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    env.token.mint(env.app.contract_address, AMOUNT.into());
    let unsigned = FundArgs { mode: 2, ..base_fund(env, 'vault', owner, successor, START + 50) };
    let args = sign_fund(env, unsigned, owner);
    invoke_private(env, PrivateAction::Fund(args), 0);
}

#[test]
fn normal_and_fast_modes_enforce_distinct_bounds() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    env.app.sync_funding_checkpoint();
    env.token.mint(env.app.contract_address, AMOUNT.into());
    let normal = FundArgs {
        mode: MODE_NORMAL,
        inactivity_seconds: NORMAL_MIN_INACTIVITY,
        grace_seconds: NORMAL_MIN_GRACE,
        ..base_fund(env, 'normal', owner, successor, START + 50),
    };
    invoke_private(env, PrivateAction::Fund(sign_fund(env, normal, owner)), 0);
    assert(env.app.get_vault('normal').mode == MODE_NORMAL, 'normal mode');
}

#[test]
#[should_panic(expected: 'AL_BAD_INTERVAL')]
fn fast_mode_rejects_interval_above_cap() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    env.token.mint(env.app.contract_address, AMOUNT.into());
    let unsigned = FundArgs {
        inactivity_seconds: FAST_INACTIVITY + 1,
        ..base_fund(env, 'vault', owner, successor, START + 50),
    };
    invoke_private(env, PrivateAction::Fund(sign_fund(env, unsigned, owner)), 0);
}

#[test]
#[should_panic(expected: 'AL_BAD_INTERVAL')]
fn normal_mode_rejects_interval_below_production_minimum() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    env.token.mint(env.app.contract_address, AMOUNT.into());
    let unsigned = FundArgs {
        mode: MODE_NORMAL,
        inactivity_seconds: NORMAL_MIN_INACTIVITY - 1,
        grace_seconds: NORMAL_MIN_GRACE,
        ..base_fund(env, 'vault', owner, successor, START + 50),
    };
    invoke_private(env, PrivateAction::Fund(sign_fund(env, unsigned, owner)), 0);
}

#[test]
#[should_panic(expected: 'AL_WRONG_TOKEN')]
fn wrong_token_is_rejected() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    let (other_token, _) = declare("MockERC20")
        .unwrap()
        .contract_class()
        .deploy(@array![])
        .unwrap();
    let unsigned = FundArgs {
        token: other_token, ..base_fund(env, 'vault', owner, successor, START + 50),
    };
    invoke_private(env, PrivateAction::Fund(sign_fund(env, unsigned, owner)), 0);
}

#[test]
#[should_panic(expected: 'AL_WRONG_AMOUNT')]
fn wrong_amount_is_rejected() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    let unsigned = FundArgs {
        amount: AMOUNT + 1, ..base_fund(env, 'vault', owner, successor, START + 50),
    };
    invoke_private(env, PrivateAction::Fund(sign_fund(env, unsigned, owner)), 0);
}

#[test]
#[should_panic(expected: 'AL_INSUFFICIENT_ASSETS')]
fn funding_requires_unencumbered_assets() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    env.app.sync_funding_checkpoint();
    let args = sign_fund(env, base_fund(env, 'vault', owner, successor, START + 50), owner);
    invoke_private(env, PrivateAction::Fund(args), 0);
}

#[test]
#[should_panic(expected: 'AL_NO_FUND_CHECKPOINT')]
fn funding_without_checkpoint_is_rejected_even_when_fully_backed() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    env.token.mint(env.app.contract_address, AMOUNT.into());
    let args = sign_fund(env, base_fund(env, 'vault', owner, successor, START + 50), owner);
    invoke_private(env, PrivateAction::Fund(args), 0);
}

#[test]
#[feature("safe_dispatcher")]
fn pre_checkpoint_donation_cannot_create_a_vault_but_fresh_exact_funding_can() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    env.token.mint(env.app.contract_address, AMOUNT.into());
    start_cheat_caller_address(env.app.contract_address, 'arbitrary-syncer'.try_into().unwrap());
    env.app.sync_funding_checkpoint();
    stop_cheat_caller_address(env.app.contract_address);
    let args = sign_fund(env, base_fund(env, 'vault', owner, successor, START + 50), owner);
    match safe_invoke_private(env, PrivateAction::Fund(args), 0) {
        Result::Ok(_) => assert(false, 'donation created vault'),
        Result::Err(_) => {},
    }
    assert(!env.app.get_vault('vault').exists, 'failed fund persisted');
    env.token.mint(env.app.contract_address, AMOUNT.into());
    invoke_private(env, PrivateAction::Fund(args), 0);
    assert(env.app.get_vault('vault').state == STATE_ACTIVE, 'fresh funding failed');
    assert(env.app.get_locked_by_token(env.token.contract_address) == AMOUNT.into(), 'lock');
}

#[test]
#[should_panic(expected: 'AL_STALE_FUND_CHECKPOINT')]
fn stale_funding_checkpoint_is_rejected() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    env.app.sync_funding_checkpoint();
    env.token.mint(env.app.contract_address, AMOUNT.into());
    set_time(env, START + MAX_FUNDING_CHECKPOINT_AGE + 1);
    let args = sign_fund(env, base_fund(env, 'vault', owner, successor, START + 50), owner);
    invoke_private(env, PrivateAction::Fund(args), 0);
}

#[test]
#[feature("safe_dispatcher")]
fn competing_fully_backed_fund_consumes_checkpoint_and_loser_safely_retries() {
    let env = deploy_env();
    let (owner_a, successor_a) = fresh_keys();
    let (owner_b, successor_b) = fresh_keys();
    let args_a = sign_fund(
        env, base_fund(env, 'vault-a', owner_a, successor_a, START + 50), owner_a,
    );
    let args_b = sign_fund(
        env, base_fund(env, 'vault-b', owner_b, successor_b, START + 50), owner_b,
    );

    env.app.sync_funding_checkpoint();
    env.token.mint(env.app.contract_address, AMOUNT.into());
    invoke_private(env, PrivateAction::Fund(args_a), 0);

    match safe_invoke_private(env, PrivateAction::Fund(args_b), 0) {
        Result::Ok(_) => assert(false, 'closed generation reused'),
        Result::Err(_) => {},
    }
    assert(!env.app.get_vault('vault-b').exists, 'loser persisted');
    assert(
        env.app.get_locked_by_token(env.token.contract_address) == AMOUNT.into(),
        'loser changed liability',
    );

    env.app.sync_funding_checkpoint();
    env.token.mint(env.app.contract_address, AMOUNT.into());
    invoke_private(env, PrivateAction::Fund(args_b), 0);
    assert(env.app.get_vault('vault-b').state == STATE_ACTIVE, 'retry failed');
    assert(
        env.app.get_locked_by_token(env.token.contract_address) == (AMOUNT * 2).into(),
        'retry liability',
    );
    assert(env.token.balance_of(env.app.contract_address) == (AMOUNT * 2).into(), 'retry assets');
}

#[test]
fn donation_dust_does_not_block_funding_or_change_exact_liability() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    env.token.mint(env.app.contract_address, 1_u256);
    env.app.sync_funding_checkpoint();
    env.token.mint(env.app.contract_address, AMOUNT.into());
    let args = sign_fund(env, base_fund(env, 'vault', owner, successor, START + 50), owner);
    invoke_private(env, PrivateAction::Fund(args), 0);
    assert(env.app.get_locked_by_token(env.token.contract_address) == AMOUNT.into(), 'dust locked');
    assert(env.token.balance_of(env.app.contract_address) == (AMOUNT + 1).into(), 'held changed');
}

#[test]
fn two_vaults_isolate_liabilities_when_one_cancels() {
    let env = deploy_env();
    let (owner_a, successor_a) = fresh_keys();
    let (owner_b, successor_b) = fresh_keys();
    fund_vault(env, 'vault-a', owner_a, successor_a);
    fund_vault(env, 'vault-b', owner_b, successor_b);
    assert(
        env.app.get_locked_by_token(env.token.contract_address) == (AMOUNT * 2).into(), '2x lock',
    );

    env.pool.create_open_note('refund-a', env.token.contract_address);
    let cancel = sign_cancel(
        env, base_exit(env, 'vault-a', STATE_ACTIVE, 1, 1, 'refund-a', START + 50), owner_a,
    );
    invoke_private(env, PrivateAction::CancelRefund(cancel), 1);
    assert(env.app.get_locked_by_token(env.token.contract_address) == AMOUNT.into(), 'b lock lost');
    assert(env.app.get_vault('vault-b').state == STATE_ACTIVE, 'b state changed');
    assert(env.token.balance_of(env.app.contract_address) == AMOUNT.into(), 'b assets lost');
}

#[test]
#[feature("safe_dispatcher")]
fn failed_approve_rolls_back_terminal_state_and_liability() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault', owner, successor);
    env.pool.create_open_note('refund', env.token.contract_address);
    env.token.set_fail_approve(true);
    let cancel = sign_cancel(
        env, base_exit(env, 'vault', STATE_ACTIVE, 1, 1, 'refund', START + 50), owner,
    );
    match safe_invoke_private(env, PrivateAction::CancelRefund(cancel), 1) {
        Result::Ok(_) => assert(false, 'approve should fail'),
        Result::Err(_) => {},
    }
    assert(env.app.get_vault('vault').state == STATE_ACTIVE, 'state not rolled back');
    assert(env.app.get_vault('vault').owner_nonce == 1, 'nonce not rolled back');
    assert(
        env.app.get_locked_by_token(env.token.contract_address) == AMOUNT.into(),
        'lock not rolled back',
    );
    assert(env.pool.note_amount('refund') == 0, 'note filled');
}

#[test]
#[feature("safe_dispatcher")]
fn failed_pool_pull_rolls_back_helper_and_pool_state() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault', owner, successor);
    env.pool.create_open_note('refund', env.token.contract_address);
    env.token.set_fail_transfer_from(true);
    let cancel = sign_cancel(
        env, base_exit(env, 'vault', STATE_ACTIVE, 1, 1, 'refund', START + 50), owner,
    );
    match safe_invoke_private(env, PrivateAction::CancelRefund(cancel), 1) {
        Result::Ok(_) => assert(false, 'pull should fail'),
        Result::Err(_) => {},
    }
    assert(env.app.get_vault('vault').state == STATE_ACTIVE, 'state not rolled back');
    assert(env.app.get_vault('vault').owner_nonce == 1, 'nonce not rolled back');
    assert(
        env.app.get_locked_by_token(env.token.contract_address) == AMOUNT.into(),
        'lock not rolled back',
    );
    assert(env.pool.note_amount('refund') == 0, 'pool note not rolled back');
    assert(
        env.token.allowance(env.app.contract_address, env.pool.contract_address) == 0,
        'allowance not rolled back',
    );
}

#[test]
fn donated_surplus_and_open_checkpoint_neither_count_as_liability_nor_weaken_private_exit() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault', owner, successor);
    env.token.mint(env.app.contract_address, 77_u256);
    env.app.sync_funding_checkpoint();
    assert(
        env.app.get_locked_by_token(env.token.contract_address) == AMOUNT.into(), 'lock changed',
    );

    env.pool.create_open_note('owner-refund', env.token.contract_address);
    let cancel = sign_cancel(
        env, base_exit(env, 'vault', STATE_ACTIVE, 1, 1, 'owner-refund', START + 50), owner,
    );
    invoke_private(env, PrivateAction::CancelRefund(cancel), 1);
    assert(env.pool.note_amount('owner-refund') == AMOUNT, 'exit underfunded');
    assert(env.token.balance_of(env.app.contract_address) == 77, 'donated surplus changed');
    assert(env.app.get_locked_by_token(env.token.contract_address) == 0, 'liability remains');
}

#[test]
#[should_panic(expected: 'AL_BAD_NONCE')]
fn consumed_heartbeat_nonce_cannot_replay() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault', owner, successor);
    let auth = sign_heartbeat(
        env, base_control(env, 'vault', STATE_ACTIVE, 1, 1, START + 50), owner,
    );
    env.app.heartbeat(auth);
    env.app.heartbeat(auth);
}

#[test]
#[should_panic(expected: 'AL_BAD_EPOCH')]
fn veto_invalidates_stale_epoch_authorization() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    prepare_claimable(env, 'vault', owner, successor);
    let grace = env.app.get_vault('vault');
    let veto = sign_veto(
        env, base_control(env, 'vault', STATE_GRACE, 1, 1, grace.claim_after + 50), owner,
    );
    env.app.veto(veto);
    let stale = sign_heartbeat(
        env, base_control(env, 'vault', STATE_ACTIVE, 1, 2, grace.claim_after + 50), owner,
    );
    env.app.heartbeat(stale);
}

#[test]
#[should_panic(expected: 'AL_EXPIRED_AUTH')]
fn expired_authorization_is_rejected() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault', owner, successor);
    let auth = sign_heartbeat(
        env, base_control(env, 'vault', STATE_ACTIVE, 1, 1, START + 1), owner,
    );
    set_time(env, START + 2);
    env.app.heartbeat(auth);
}

#[test]
#[should_panic(expected: 'AL_AUTH_WINDOW_LONG')]
fn authorization_window_is_bounded() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault', owner, successor);
    let auth = sign_heartbeat(
        env, base_control(env, 'vault', STATE_ACTIVE, 1, 1, START + MAX_AUTH_WINDOW + 1), owner,
    );
    env.app.heartbeat(auth);
}

#[test]
#[should_panic(expected: 'AL_BAD_SIGNATURE')]
fn changing_valid_until_breaks_signature() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault', owner, successor);
    let signed = sign_heartbeat(
        env, base_control(env, 'vault', STATE_ACTIVE, 1, 1, START + 50), owner,
    );
    env.app.heartbeat(ControlArgs { valid_until: START + 51, ..signed });
}

#[test]
#[should_panic(expected: 'AL_BAD_SIGNATURE')]
fn authorization_is_bound_to_contract_address() {
    let env_a = deploy_env();
    let app_b = deploy_second_app(env_a);
    let env_b = Env { app: app_b, ..env_a };
    let (owner, successor) = fresh_keys();
    fund_vault(env_a, 'vault', owner, successor);
    fund_vault(env_b, 'vault', owner, successor);
    let signed_for_a = sign_heartbeat(
        env_a, base_control(env_a, 'vault', STATE_ACTIVE, 1, 1, START + 50), owner,
    );
    env_b.app.heartbeat(signed_for_a);
}

#[test]
#[should_panic(expected: 'AL_BAD_SIGNATURE')]
fn authorization_is_bound_to_chain_id() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault', owner, successor);
    let auth = base_control(env, 'vault', STATE_ACTIVE, 1, 1, START + 50);
    let hash = message_hash(
        HEARTBEAT_TAG,
        'definitely-wrong-chain',
        env.app.contract_address,
        auth.vault_id,
        auth.token,
        auth.amount,
        auth.expected_state,
        auth.expected_epoch,
        auth.expected_nonce,
        owner.public_key,
        0,
        auth.valid_until,
        array![START.into()].span(),
    );
    let (sig_r, sig_s) = owner.sign(hash).unwrap();
    env.app.heartbeat(ControlArgs { sig_r, sig_s, ..auth });
}

#[test]
#[should_panic(expected: 'AL_BAD_SIGNATURE')]
fn authorization_is_bound_to_vault_id() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    env.token.mint(env.app.contract_address, AMOUNT.into());
    let original = base_fund(env, 'vault-a', owner, successor, START + 50);
    let signed = sign_fund(env, original, owner);
    invoke_private(env, PrivateAction::Fund(FundArgs { vault_id: 'vault-b', ..signed }), 0);
}

#[test]
#[should_panic(expected: 'AL_BAD_SIGNATURE')]
fn authorization_for_one_operation_cannot_authorize_another() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    prepare_claimable(env, 'vault', owner, successor);
    let vault = env.app.get_vault('vault');
    let claim_shape = base_control(env, 'vault', STATE_GRACE, 1, 1, vault.claim_after + 50);
    env.app.veto(sign_request(env, claim_shape, successor));
}

#[test]
#[should_panic(expected: 'AL_BAD_SIGNATURE')]
fn redirected_claim_note_is_rejected() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    prepare_claimable(env, 'vault', owner, successor);
    let vault = env.app.get_vault('vault');
    set_time(env, vault.claim_after);
    let signed = sign_claim(
        env,
        base_exit(env, 'vault', STATE_GRACE, 1, 1, 'intended-note', vault.claim_after + 50),
        successor,
    );
    invoke_private(env, PrivateAction::Claim(ExitArgs { note_id: 'attacker-note', ..signed }), 1);
}

#[test]
#[should_panic(expected: 'AL_BAD_STATE')]
fn claimed_vault_cannot_be_claimed_twice() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    prepare_claimable(env, 'vault', owner, successor);
    let vault = env.app.get_vault('vault');
    set_time(env, vault.claim_after);
    env.pool.create_open_note('note-1', env.token.contract_address);
    let first = sign_claim(
        env,
        base_exit(env, 'vault', STATE_GRACE, 1, 1, 'note-1', vault.claim_after + 50),
        successor,
    );
    invoke_private(env, PrivateAction::Claim(first), 1);
    env.pool.create_open_note('note-2', env.token.contract_address);
    let replay = ExitArgs { note_id: 'note-2', expected_nonce: 2, ..first };
    invoke_private(env, PrivateAction::Claim(replay), 1);
}

#[test]
#[should_panic(expected: 'AL_BAD_STATE')]
fn claimed_vault_cannot_be_cancelled() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    prepare_claimable(env, 'vault', owner, successor);
    let grace = env.app.get_vault('vault');
    set_time(env, grace.claim_after);
    env.pool.create_open_note('claim-note', env.token.contract_address);
    let claim = sign_claim(
        env,
        base_exit(env, 'vault', STATE_GRACE, 1, 1, 'claim-note', grace.claim_after + 50),
        successor,
    );
    invoke_private(env, PrivateAction::Claim(claim), 1);
    let cancel = base_exit(
        env,
        'vault',
        STATE_ACTIVE,
        1,
        env.app.get_vault('vault').owner_nonce,
        'refund-note',
        grace.claim_after + 50,
    );
    invoke_private(env, PrivateAction::CancelRefund(cancel), 1);
}

#[test]
#[should_panic(expected: 'AL_BAD_STATE')]
fn cancelled_vault_cannot_be_claimed() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault', owner, successor);
    env.pool.create_open_note('refund', env.token.contract_address);
    let cancel = sign_cancel(
        env, base_exit(env, 'vault', STATE_ACTIVE, 1, 1, 'refund', START + 50), owner,
    );
    invoke_private(env, PrivateAction::CancelRefund(cancel), 1);
    let claim = base_exit(env, 'vault', STATE_GRACE, 1, 0, 'note', START + 50);
    invoke_private(env, PrivateAction::Claim(claim), 1);
}

#[test]
#[should_panic(expected: 'AL_BAD_EXPECTED_STATE')]
fn cancel_is_restricted_to_active_state() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    prepare_claimable(env, 'vault', owner, successor);
    let cancel = base_exit(env, 'vault', STATE_GRACE, 1, 1, 'refund', START + 50);
    invoke_private(env, PrivateAction::CancelRefund(cancel), 1);
}

#[test]
#[should_panic(expected: 'AL_ZERO_NOTE')]
fn private_exit_requires_nonzero_destination_note() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    fund_vault(env, 'vault', owner, successor);
    let cancel = base_exit(env, 'vault', STATE_ACTIVE, 1, 1, 0, START + 50);
    invoke_private(env, PrivateAction::CancelRefund(cancel), 1);
}

#[test]
#[feature("safe_dispatcher")]
fn veto_and_claim_race_is_first_valid_transaction_wins() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    prepare_claimable(env, 'vault', owner, successor);
    let grace = env.app.get_vault('vault');
    set_time(env, grace.claim_after);
    let veto = sign_veto(
        env, base_control(env, 'vault', STATE_GRACE, 1, 1, grace.claim_after + 50), owner,
    );
    let claim = sign_claim(
        env, base_exit(env, 'vault', STATE_GRACE, 1, 1, 'note', grace.claim_after + 50), successor,
    );
    env.app.veto(veto);
    let mut calldata = array![];
    PrivateAction::Claim(claim).serialize(ref calldata);
    let failed = IMockPrivacyPoolSafeDispatcher { contract_address: env.pool.contract_address }
        .invoke_external(env.app.contract_address, calldata.span(), 1);
    match failed {
        Result::Ok(_) => assert(false, 'claim won after veto'),
        Result::Err(_) => {},
    }
    let vault = env.app.get_vault('vault');
    assert(vault.state == STATE_ACTIVE, 'veto did not win');
    assert(vault.epoch == 2, 'epoch not advanced');
    assert(env.app.get_locked_by_token(env.token.contract_address) == AMOUNT.into(), 'funds moved');
}

#[test]
#[feature("safe_dispatcher")]
fn claim_and_veto_race_is_first_valid_transaction_wins() {
    let env = deploy_env();
    let (owner, successor) = fresh_keys();
    prepare_claimable(env, 'vault', owner, successor);
    let grace = env.app.get_vault('vault');
    set_time(env, grace.claim_after);
    let veto = sign_veto(
        env, base_control(env, 'vault', STATE_GRACE, 1, 1, grace.claim_after + 50), owner,
    );
    env.pool.create_open_note('note', env.token.contract_address);
    let claim = sign_claim(
        env, base_exit(env, 'vault', STATE_GRACE, 1, 1, 'note', grace.claim_after + 50), successor,
    );
    invoke_private(env, PrivateAction::Claim(claim), 1);
    let safe = IAfterlightSafeDispatcher { contract_address: env.app.contract_address };
    match safe.veto(veto) {
        Result::Ok(_) => assert(false, 'veto won after claim'),
        Result::Err(_) => {},
    }
    assert(env.app.get_vault('vault').state == STATE_CLAIMED, 'claim did not win');
    assert(env.pool.note_amount('note') == AMOUNT, 'claim note missing');
    assert(env.app.get_locked_by_token(env.token.contract_address) == 0, 'lock remains');
}
