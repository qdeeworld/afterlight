use core::poseidon::poseidon_hash_span;

pub use privacy::objects::OpenNoteDeposit;
use starknet::ContractAddress;

pub const STATE_UNSET: u8 = 0;
pub const STATE_ACTIVE: u8 = 1;
pub const STATE_GRACE: u8 = 2;
pub const STATE_CLAIMED: u8 = 3;
pub const STATE_CANCELLED: u8 = 4;

pub const MODE_NORMAL: u8 = 0;
pub const MODE_FAST_DEMO: u8 = 1;

pub const FUND_TAG: felt252 = 'AFTERLIGHT_FUND_V1';
pub const HEARTBEAT_TAG: felt252 = 'AFTERLIGHT_HEARTBEAT_V1';
pub const REQUEST_TAG: felt252 = 'AFTERLIGHT_REQUEST_V1';
pub const VETO_TAG: felt252 = 'AFTERLIGHT_VETO_V1';
pub const CANCEL_TAG: felt252 = 'AFTERLIGHT_CANCEL_V1';
pub const CLAIM_TAG: felt252 = 'AFTERLIGHT_CLAIM_V1';

/// Enum order is part of the Wallet API calldata ABI. Never reorder it.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub enum PrivateAction {
    Fund: FundArgs,
    CancelRefund: ExitArgs,
    Claim: ExitArgs,
}

#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct FundArgs {
    pub vault_id: felt252,
    pub token: ContractAddress,
    pub amount: u128,
    pub mode: u8,
    pub owner_key: felt252,
    pub successor_key: felt252,
    pub inactivity_seconds: u64,
    pub grace_seconds: u64,
    pub valid_until: u64,
    pub sig_r: felt252,
    pub sig_s: felt252,
}

#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct ExitArgs {
    pub vault_id: felt252,
    pub token: ContractAddress,
    pub amount: u128,
    pub expected_state: u8,
    pub expected_epoch: u64,
    pub expected_nonce: u64,
    pub note_id: felt252,
    pub valid_until: u64,
    pub sig_r: felt252,
    pub sig_s: felt252,
}

#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct ControlArgs {
    pub vault_id: felt252,
    pub token: ContractAddress,
    pub amount: u128,
    pub expected_state: u8,
    pub expected_epoch: u64,
    pub expected_nonce: u64,
    pub valid_until: u64,
    pub sig_r: felt252,
    pub sig_s: felt252,
}

#[derive(Serde, Copy, Drop, PartialEq, Debug, starknet::Store)]
pub struct Vault {
    pub exists: bool,
    pub state: u8,
    pub mode: u8,
    pub owner_key: felt252,
    pub successor_key: felt252,
    pub token: ContractAddress,
    pub amount: u128,
    pub inactivity_seconds: u64,
    pub grace_seconds: u64,
    pub last_heartbeat: u64,
    pub requested_at: u64,
    pub claim_after: u64,
    pub epoch: u64,
    pub owner_nonce: u64,
    pub successor_nonce: u64,
}

#[derive(Serde, Copy, Drop, PartialEq, Debug, starknet::Store)]
pub struct Config {
    pub pool: ContractAddress,
    pub token: ContractAddress,
    pub surplus_admin: ContractAddress,
    pub fixed_amount: u128,
    pub normal_min_inactivity: u64,
    pub normal_min_grace: u64,
    pub fast_max_inactivity: u64,
    pub fast_max_grace: u64,
    pub max_interval: u64,
    pub max_auth_window: u64,
    pub max_funding_checkpoint_age: u64,
}

/// Shared, fixed-width signature prefix. Operation-specific immutable state is
/// appended as `extras`, so a signature for one transition cannot authorize
/// another transition or another version of the protocol.
pub fn message_hash(
    tag: felt252,
    chain_id: felt252,
    contract_address: ContractAddress,
    vault_id: felt252,
    token: ContractAddress,
    amount: u128,
    expected_state: u8,
    epoch: u64,
    nonce: u64,
    signer_key: felt252,
    note_id: felt252,
    valid_until: u64,
    extras: Span<felt252>,
) -> felt252 {
    let mut values = array![
        tag, chain_id, contract_address.into(), vault_id, token.into(), amount.into(),
        expected_state.into(), epoch.into(), nonce.into(), signer_key, note_id, valid_until.into(),
    ];
    for extra in extras {
        values.append(*extra);
    }
    poseidon_hash_span(values.span())
}
