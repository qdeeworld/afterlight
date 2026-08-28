use starknet::ContractAddress;
use crate::common::{Config, ControlArgs, OpenNoteDeposit, PrivateAction, Vault};

#[starknet::interface]
pub trait IAfterlight<T> {
    fn privacy_invoke(ref self: T, action: PrivateAction) -> Span<OpenNoteDeposit>;
    fn sync_funding_checkpoint(ref self: T);
    fn heartbeat(ref self: T, auth: ControlArgs);
    fn request_recovery(ref self: T, auth: ControlArgs);
    fn veto(ref self: T, auth: ControlArgs);
    fn get_vault(self: @T, vault_id: felt252) -> Vault;
    fn get_locked_by_token(self: @T, token: ContractAddress) -> u256;
    fn get_config(self: @T) -> Config;
}

pub mod errors {
    pub const INVALID_CONFIG: felt252 = 'AL_INVALID_CONFIG';
    pub const NOT_POOL: felt252 = 'AL_NOT_POOL';
    pub const ZERO_VAULT: felt252 = 'AL_ZERO_VAULT';
    pub const VAULT_EXISTS: felt252 = 'AL_VAULT_EXISTS';
    pub const VAULT_NOT_FOUND: felt252 = 'AL_VAULT_NOT_FOUND';
    pub const ZERO_KEY: felt252 = 'AL_ZERO_KEY';
    pub const SAME_KEY: felt252 = 'AL_SAME_KEY';
    pub const KEY_REUSED: felt252 = 'AL_KEY_REUSED';
    pub const BAD_MODE: felt252 = 'AL_BAD_MODE';
    pub const BAD_INTERVAL: felt252 = 'AL_BAD_INTERVAL';
    pub const WRONG_TOKEN: felt252 = 'AL_WRONG_TOKEN';
    pub const WRONG_AMOUNT: felt252 = 'AL_WRONG_AMOUNT';
    pub const BAD_STATE: felt252 = 'AL_BAD_STATE';
    pub const BAD_EXPECTED_STATE: felt252 = 'AL_BAD_EXPECTED_STATE';
    pub const BAD_EPOCH: felt252 = 'AL_BAD_EPOCH';
    pub const BAD_NONCE: felt252 = 'AL_BAD_NONCE';
    pub const EXPIRED_AUTH: felt252 = 'AL_EXPIRED_AUTH';
    pub const AUTH_WINDOW_TOO_LONG: felt252 = 'AL_AUTH_WINDOW_LONG';
    pub const BAD_SIGNATURE: felt252 = 'AL_BAD_SIGNATURE';
    pub const NOT_INACTIVE: felt252 = 'AL_NOT_INACTIVE';
    pub const CLAIM_TOO_EARLY: felt252 = 'AL_CLAIM_TOO_EARLY';
    pub const ZERO_NOTE: felt252 = 'AL_ZERO_NOTE';
    pub const INSUFFICIENT_ASSETS: felt252 = 'AL_INSUFFICIENT_ASSETS';
    pub const NO_FUND_CHECKPOINT: felt252 = 'AL_NO_FUND_CHECKPOINT';
    pub const STALE_FUND_CHECKPOINT: felt252 = 'AL_STALE_FUND_CHECKPOINT';
    pub const LIABILITY_UNDERFLOW: felt252 = 'AL_LIABILITY_UNDERFLOW';
    pub const APPROVE_FAILED: felt252 = 'AL_APPROVE_FAILED';
    pub const TRANSFER_FAILED: felt252 = 'AL_TRANSFER_FAILED';
}

#[starknet::contract]
pub mod Afterlight {
    use core::ecdsa::check_ecdsa_signature;
    use core::num::traits::Zero;
    use starknet::storage::{
        Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use starknet::{
        ContractAddress, get_block_timestamp, get_caller_address, get_contract_address, get_tx_info,
    };
    use crate::common::{
        CANCEL_TAG, CLAIM_TAG, Config, ControlArgs, ExitArgs, FUND_TAG, FundArgs, HEARTBEAT_TAG,
        MODE_FAST_DEMO, MODE_NORMAL, OpenNoteDeposit, PrivateAction, REQUEST_TAG, STATE_ACTIVE,
        STATE_CANCELLED, STATE_CLAIMED, STATE_GRACE, STATE_UNSET, VETO_TAG, Vault, message_hash,
    };
    use super::errors;

    const FAST_DEMO_AMOUNT_CAP: u128 = 10_000_000_000_000_000_000;

    #[starknet::interface]
    trait IERC20<T> {
        fn balance_of(self: @T, account: ContractAddress) -> u256;
        fn approve(ref self: T, spender: ContractAddress, amount: u256) -> bool;
    }

    /// Vault fields use separate maps deliberately. Hot transitions read and
    /// write only the fields they need instead of deserializing and rewriting a
    /// fifteen-slot Store struct on every heartbeat or request.
    #[storage]
    struct Storage {
        pool: ContractAddress,
        token: ContractAddress,
        fixed_amount: u128,
        normal_min_inactivity: u64,
        normal_min_grace: u64,
        fast_max_inactivity: u64,
        fast_max_grace: u64,
        max_interval: u64,
        max_auth_window: u64,
        max_funding_checkpoint_age: u64,
        state: Map<felt252, u8>,
        mode: Map<felt252, u8>,
        owner_key: Map<felt252, felt252>,
        successor_key: Map<felt252, felt252>,
        inactivity_seconds: Map<felt252, u64>,
        grace_seconds: Map<felt252, u64>,
        last_heartbeat: Map<felt252, u64>,
        requested_at: Map<felt252, u64>,
        claim_after: Map<felt252, u64>,
        epoch: Map<felt252, u64>,
        owner_nonce: Map<felt252, u64>,
        successor_nonce: Map<felt252, u64>,
        key_used: Map<felt252, bool>,
        locked: u256,
        funding_checkpoint_balance: u256,
        funding_checkpoint_at: u64,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        VaultFunded: VaultFunded,
        HeartbeatRecorded: HeartbeatRecorded,
        RecoveryRequested: RecoveryRequested,
        RecoveryVetoed: RecoveryVetoed,
        VaultCancelled: VaultCancelled,
        RecoveryClaimed: RecoveryClaimed,
        FundingCheckpointSynced: FundingCheckpointSynced,
    }

    #[derive(Drop, PartialEq, starknet::Event)]
    pub struct VaultFunded {
        #[key]
        pub vault_id: felt252,
        pub mode: u8,
        pub epoch: u64,
        pub amount: u128,
        pub last_heartbeat: u64,
    }

    #[derive(Drop, PartialEq, starknet::Event)]
    pub struct HeartbeatRecorded {
        #[key]
        pub vault_id: felt252,
        pub epoch: u64,
        pub consumed_nonce: u64,
        pub at: u64,
    }

    #[derive(Drop, PartialEq, starknet::Event)]
    pub struct RecoveryRequested {
        #[key]
        pub vault_id: felt252,
        pub epoch: u64,
        pub consumed_nonce: u64,
        pub requested_at: u64,
        pub claim_after: u64,
    }

    #[derive(Drop, PartialEq, starknet::Event)]
    pub struct RecoveryVetoed {
        #[key]
        pub vault_id: felt252,
        pub old_epoch: u64,
        pub new_epoch: u64,
        pub consumed_nonce: u64,
        pub at: u64,
    }

    #[derive(Drop, PartialEq, starknet::Event)]
    pub struct VaultCancelled {
        #[key]
        pub vault_id: felt252,
        pub epoch: u64,
        pub note_id: felt252,
        pub amount: u128,
    }

    #[derive(Drop, PartialEq, starknet::Event)]
    pub struct RecoveryClaimed {
        #[key]
        pub vault_id: felt252,
        pub epoch: u64,
        pub note_id: felt252,
        pub amount: u128,
    }

    #[derive(Drop, PartialEq, starknet::Event)]
    pub struct FundingCheckpointSynced {
        pub balance: u256,
        pub synced_at: u64,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        pool: ContractAddress,
        token: ContractAddress,
        fixed_amount: u128,
        normal_min_inactivity: u64,
        normal_min_grace: u64,
        fast_max_inactivity: u64,
        fast_max_grace: u64,
        max_interval: u64,
        max_auth_window: u64,
        max_funding_checkpoint_age: u64,
    ) {
        assert(pool.is_non_zero(), errors::INVALID_CONFIG);
        assert(token.is_non_zero(), errors::INVALID_CONFIG);
        assert(fixed_amount > 0, errors::INVALID_CONFIG);
        assert(normal_min_inactivity > 0, errors::INVALID_CONFIG);
        assert(normal_min_grace > 0, errors::INVALID_CONFIG);
        assert(fast_max_inactivity > 0, errors::INVALID_CONFIG);
        assert(fast_max_grace > 0, errors::INVALID_CONFIG);
        assert(max_interval >= normal_min_inactivity, errors::INVALID_CONFIG);
        assert(max_interval >= normal_min_grace, errors::INVALID_CONFIG);
        assert(max_interval >= fast_max_inactivity, errors::INVALID_CONFIG);
        assert(max_interval >= fast_max_grace, errors::INVALID_CONFIG);
        assert(max_auth_window > 0 && max_auth_window <= max_interval, errors::INVALID_CONFIG);
        assert(
            max_funding_checkpoint_age > 0 && max_funding_checkpoint_age <= max_interval,
            errors::INVALID_CONFIG,
        );
        self.pool.write(pool);
        self.token.write(token);
        self.fixed_amount.write(fixed_amount);
        self.normal_min_inactivity.write(normal_min_inactivity);
        self.normal_min_grace.write(normal_min_grace);
        self.fast_max_inactivity.write(fast_max_inactivity);
        self.fast_max_grace.write(fast_max_grace);
        self.max_interval.write(max_interval);
        self.max_auth_window.write(max_auth_window);
        self.max_funding_checkpoint_age.write(max_funding_checkpoint_age);
    }

    #[abi(embed_v0)]
    impl AfterlightImpl of super::IAfterlight<ContractState> {
        fn privacy_invoke(ref self: ContractState, action: PrivateAction) -> Span<OpenNoteDeposit> {
            assert(get_caller_address() == self.pool.read(), errors::NOT_POOL);
            match action {
                PrivateAction::Fund(args) => self._fund(args),
                PrivateAction::CancelRefund(args) => self._cancel_refund(args),
                PrivateAction::Claim(args) => self._claim(args),
            }
        }

        /// Opens a global, one-shot funding checkpoint against the helper's
        /// current canonical-token balance. The pool's subsequent private
        /// transfer must add the exact reserve before FUND can consume it.
        /// Anyone may refresh the checkpoint; no caller identity is authority.
        fn sync_funding_checkpoint(ref self: ContractState) {
            let token = self.token.read();
            let balance = IERC20Dispatcher { contract_address: token }
                .balance_of(get_contract_address());
            let now = get_block_timestamp();
            self.funding_checkpoint_balance.write(balance);
            self.funding_checkpoint_at.write(now);
            self.emit(FundingCheckpointSynced { balance, synced_at: now });
        }

        fn heartbeat(ref self: ContractState, auth: ControlArgs) {
            self._validate_control(auth, STATE_ACTIVE, true);
            let id = auth.vault_id;
            let key = self.owner_key.entry(id).read();
            let last = self.last_heartbeat.entry(id).read();
            let message = self._message(HEARTBEAT_TAG, auth, key, 0, array![last.into()].span());
            assert(
                check_ecdsa_signature(message, key, auth.sig_r, auth.sig_s), errors::BAD_SIGNATURE,
            );
            let now = get_block_timestamp();
            self.owner_nonce.entry(id).write(auth.expected_nonce + 1);
            self.last_heartbeat.entry(id).write(now);
            self
                .emit(
                    HeartbeatRecorded {
                        vault_id: id,
                        epoch: auth.expected_epoch,
                        consumed_nonce: auth.expected_nonce,
                        at: now,
                    },
                );
        }

        fn request_recovery(ref self: ContractState, auth: ControlArgs) {
            self._validate_control(auth, STATE_ACTIVE, false);
            let id = auth.vault_id;
            let last = self.last_heartbeat.entry(id).read();
            let now = get_block_timestamp();
            assert(now >= last + self.inactivity_seconds.entry(id).read(), errors::NOT_INACTIVE);
            let key = self.successor_key.entry(id).read();
            let message = self._message(REQUEST_TAG, auth, key, 0, array![last.into()].span());
            assert(
                check_ecdsa_signature(message, key, auth.sig_r, auth.sig_s), errors::BAD_SIGNATURE,
            );
            let due = now + self.grace_seconds.entry(id).read();
            self.state.entry(id).write(STATE_GRACE);
            self.successor_nonce.entry(id).write(auth.expected_nonce + 1);
            self.requested_at.entry(id).write(now);
            self.claim_after.entry(id).write(due);
            self
                .emit(
                    RecoveryRequested {
                        vault_id: id,
                        epoch: auth.expected_epoch,
                        consumed_nonce: auth.expected_nonce,
                        requested_at: now,
                        claim_after: due,
                    },
                );
        }

        fn veto(ref self: ContractState, auth: ControlArgs) {
            self._validate_control(auth, STATE_GRACE, true);
            let id = auth.vault_id;
            let requested = self.requested_at.entry(id).read();
            let due = self.claim_after.entry(id).read();
            let key = self.owner_key.entry(id).read();
            let message = self
                ._message(VETO_TAG, auth, key, 0, array![requested.into(), due.into()].span());
            assert(
                check_ecdsa_signature(message, key, auth.sig_r, auth.sig_s), errors::BAD_SIGNATURE,
            );
            let now = get_block_timestamp();
            self.state.entry(id).write(STATE_ACTIVE);
            self.epoch.entry(id).write(auth.expected_epoch + 1);
            self.owner_nonce.entry(id).write(auth.expected_nonce + 1);
            self.last_heartbeat.entry(id).write(now);
            self.requested_at.entry(id).write(0);
            self.claim_after.entry(id).write(0);
            self
                .emit(
                    RecoveryVetoed {
                        vault_id: id,
                        old_epoch: auth.expected_epoch,
                        new_epoch: auth.expected_epoch + 1,
                        consumed_nonce: auth.expected_nonce,
                        at: now,
                    },
                );
        }

        fn get_vault(self: @ContractState, vault_id: felt252) -> Vault {
            let state = self.state.entry(vault_id).read();
            Vault {
                exists: state != STATE_UNSET,
                state,
                mode: self.mode.entry(vault_id).read(),
                owner_key: self.owner_key.entry(vault_id).read(),
                successor_key: self.successor_key.entry(vault_id).read(),
                token: self.token.read(),
                amount: self.fixed_amount.read(),
                inactivity_seconds: self.inactivity_seconds.entry(vault_id).read(),
                grace_seconds: self.grace_seconds.entry(vault_id).read(),
                last_heartbeat: self.last_heartbeat.entry(vault_id).read(),
                requested_at: self.requested_at.entry(vault_id).read(),
                claim_after: self.claim_after.entry(vault_id).read(),
                epoch: self.epoch.entry(vault_id).read(),
                owner_nonce: self.owner_nonce.entry(vault_id).read(),
                successor_nonce: self.successor_nonce.entry(vault_id).read(),
            }
        }

        fn get_locked_by_token(self: @ContractState, token: ContractAddress) -> u256 {
            if token == self.token.read() {
                self.locked.read()
            } else {
                0
            }
        }

        fn get_config(self: @ContractState) -> Config {
            Config {
                pool: self.pool.read(),
                token: self.token.read(),
                fixed_amount: self.fixed_amount.read(),
                normal_min_inactivity: self.normal_min_inactivity.read(),
                normal_min_grace: self.normal_min_grace.read(),
                fast_max_inactivity: self.fast_max_inactivity.read(),
                fast_max_grace: self.fast_max_grace.read(),
                max_interval: self.max_interval.read(),
                max_auth_window: self.max_auth_window.read(),
                max_funding_checkpoint_age: self.max_funding_checkpoint_age.read(),
            }
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn _fund(ref self: ContractState, args: FundArgs) -> Span<OpenNoteDeposit> {
            let id = args.vault_id;
            assert(id != 0, errors::ZERO_VAULT);
            assert(self.state.entry(id).read() == STATE_UNSET, errors::VAULT_EXISTS);
            assert(args.owner_key != 0 && args.successor_key != 0, errors::ZERO_KEY);
            assert(args.owner_key != args.successor_key, errors::SAME_KEY);
            assert(!self.key_used.entry(args.owner_key).read(), errors::KEY_REUSED);
            assert(!self.key_used.entry(args.successor_key).read(), errors::KEY_REUSED);
            self._validate_token_amount(args.token, args.amount);
            self._validate_mode(args);
            self._validate_window(args.valid_until);
            let message = message_hash(
                FUND_TAG,
                self._chain_id(),
                get_contract_address(),
                id,
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
            assert(
                check_ecdsa_signature(message, args.owner_key, args.sig_r, args.sig_s),
                errors::BAD_SIGNATURE,
            );
            let token = self.token.read();
            let held = IERC20Dispatcher { contract_address: token }
                .balance_of(get_contract_address());
            let locked = self.locked.read();
            let now = get_block_timestamp();
            let checkpoint_at = self.funding_checkpoint_at.read();
            assert(checkpoint_at > 0, errors::NO_FUND_CHECKPOINT);
            assert(now >= checkpoint_at, errors::STALE_FUND_CHECKPOINT);
            assert(
                now - checkpoint_at <= self.max_funding_checkpoint_age.read(),
                errors::STALE_FUND_CHECKPOINT,
            );
            let checkpoint_balance = self.funding_checkpoint_balance.read();
            assert(held >= checkpoint_balance + args.amount.into(), errors::INSUFFICIENT_ASSETS);
            assert(held >= locked + args.amount.into(), errors::INSUFFICIENT_ASSETS);
            // Consuming before vault writes is safe: any later revert rolls the
            // whole call back, while a successful FUND closes this checkpoint.
            self.funding_checkpoint_at.write(0);
            self.state.entry(id).write(STATE_ACTIVE);
            self.mode.entry(id).write(args.mode);
            self.owner_key.entry(id).write(args.owner_key);
            self.successor_key.entry(id).write(args.successor_key);
            self.inactivity_seconds.entry(id).write(args.inactivity_seconds);
            self.grace_seconds.entry(id).write(args.grace_seconds);
            self.last_heartbeat.entry(id).write(now);
            self.epoch.entry(id).write(1);
            self.owner_nonce.entry(id).write(1);
            self.key_used.entry(args.owner_key).write(true);
            self.key_used.entry(args.successor_key).write(true);
            self.locked.write(locked + args.amount.into());
            self
                .emit(
                    VaultFunded {
                        vault_id: id,
                        mode: args.mode,
                        epoch: 1,
                        amount: args.amount,
                        last_heartbeat: now,
                    },
                );
            [].span()
        }

        fn _cancel_refund(ref self: ContractState, args: ExitArgs) -> Span<OpenNoteDeposit> {
            self._validate_exit(args, STATE_ACTIVE, true);
            let id = args.vault_id;
            let key = self.owner_key.entry(id).read();
            let message = self._exit_message(CANCEL_TAG, args, key, array![].span());
            assert(
                check_ecdsa_signature(message, key, args.sig_r, args.sig_s), errors::BAD_SIGNATURE,
            );
            self.state.entry(id).write(STATE_CANCELLED);
            self.owner_nonce.entry(id).write(args.expected_nonce + 1);
            self._settle(args.amount);
            self
                .emit(
                    VaultCancelled {
                        vault_id: id,
                        epoch: args.expected_epoch,
                        note_id: args.note_id,
                        amount: args.amount,
                    },
                );
            [OpenNoteDeposit { note_id: args.note_id, token: args.token, amount: args.amount }]
                .span()
        }

        fn _claim(ref self: ContractState, args: ExitArgs) -> Span<OpenNoteDeposit> {
            self._validate_exit(args, STATE_GRACE, false);
            let id = args.vault_id;
            let requested = self.requested_at.entry(id).read();
            let due = self.claim_after.entry(id).read();
            assert(get_block_timestamp() >= due, errors::CLAIM_TOO_EARLY);
            let key = self.successor_key.entry(id).read();
            let message = self
                ._exit_message(CLAIM_TAG, args, key, array![requested.into(), due.into()].span());
            assert(
                check_ecdsa_signature(message, key, args.sig_r, args.sig_s), errors::BAD_SIGNATURE,
            );
            self.state.entry(id).write(STATE_CLAIMED);
            self.successor_nonce.entry(id).write(args.expected_nonce + 1);
            self._settle(args.amount);
            self
                .emit(
                    RecoveryClaimed {
                        vault_id: id,
                        epoch: args.expected_epoch,
                        note_id: args.note_id,
                        amount: args.amount,
                    },
                );
            [OpenNoteDeposit { note_id: args.note_id, token: args.token, amount: args.amount }]
                .span()
        }

        fn _validate_control(
            self: @ContractState, auth: ControlArgs, required_state: u8, owner_role: bool,
        ) {
            let id = auth.vault_id;
            let state = self.state.entry(id).read();
            assert(state != STATE_UNSET, errors::VAULT_NOT_FOUND);
            self._validate_token_amount(auth.token, auth.amount);
            assert(auth.expected_state == required_state, errors::BAD_EXPECTED_STATE);
            assert(state == auth.expected_state, errors::BAD_STATE);
            assert(self.epoch.entry(id).read() == auth.expected_epoch, errors::BAD_EPOCH);
            let nonce = if owner_role {
                self.owner_nonce.entry(id).read()
            } else {
                self.successor_nonce.entry(id).read()
            };
            assert(nonce == auth.expected_nonce, errors::BAD_NONCE);
            self._validate_window(auth.valid_until);
        }

        fn _validate_exit(
            self: @ContractState, args: ExitArgs, required_state: u8, owner_role: bool,
        ) {
            let id = args.vault_id;
            let state = self.state.entry(id).read();
            assert(state != STATE_UNSET, errors::VAULT_NOT_FOUND);
            self._validate_token_amount(args.token, args.amount);
            assert(args.note_id != 0, errors::ZERO_NOTE);
            assert(args.expected_state == required_state, errors::BAD_EXPECTED_STATE);
            assert(state == args.expected_state, errors::BAD_STATE);
            assert(self.epoch.entry(id).read() == args.expected_epoch, errors::BAD_EPOCH);
            let nonce = if owner_role {
                self.owner_nonce.entry(id).read()
            } else {
                self.successor_nonce.entry(id).read()
            };
            assert(nonce == args.expected_nonce, errors::BAD_NONCE);
            self._validate_window(args.valid_until);
        }

        fn _validate_token_amount(self: @ContractState, token: ContractAddress, amount: u128) {
            assert(token == self.token.read(), errors::WRONG_TOKEN);
            assert(amount == self.fixed_amount.read(), errors::WRONG_AMOUNT);
        }

        fn _validate_mode(self: @ContractState, args: FundArgs) {
            assert(args.inactivity_seconds > 0 && args.grace_seconds > 0, errors::BAD_INTERVAL);
            assert(args.inactivity_seconds <= self.max_interval.read(), errors::BAD_INTERVAL);
            assert(args.grace_seconds <= self.max_interval.read(), errors::BAD_INTERVAL);
            if args.mode == MODE_NORMAL {
                assert(
                    args.inactivity_seconds >= self.normal_min_inactivity.read(),
                    errors::BAD_INTERVAL,
                );
                assert(args.grace_seconds >= self.normal_min_grace.read(), errors::BAD_INTERVAL);
            } else if args.mode == MODE_FAST_DEMO {
                assert(args.amount <= FAST_DEMO_AMOUNT_CAP, errors::WRONG_AMOUNT);
                assert(
                    args.inactivity_seconds <= self.fast_max_inactivity.read(),
                    errors::BAD_INTERVAL,
                );
                assert(args.grace_seconds <= self.fast_max_grace.read(), errors::BAD_INTERVAL);
            } else {
                assert(false, errors::BAD_MODE);
            }
        }

        fn _validate_window(self: @ContractState, valid_until: u64) {
            let now = get_block_timestamp();
            assert(valid_until >= now, errors::EXPIRED_AUTH);
            assert(valid_until - now <= self.max_auth_window.read(), errors::AUTH_WINDOW_TOO_LONG);
        }

        fn _message(
            self: @ContractState,
            tag: felt252,
            auth: ControlArgs,
            signer: felt252,
            note_id: felt252,
            extras: Span<felt252>,
        ) -> felt252 {
            message_hash(
                tag,
                self._chain_id(),
                get_contract_address(),
                auth.vault_id,
                auth.token,
                auth.amount,
                auth.expected_state,
                auth.expected_epoch,
                auth.expected_nonce,
                signer,
                note_id,
                auth.valid_until,
                extras,
            )
        }

        fn _exit_message(
            self: @ContractState,
            tag: felt252,
            args: ExitArgs,
            signer: felt252,
            extras: Span<felt252>,
        ) -> felt252 {
            message_hash(
                tag,
                self._chain_id(),
                get_contract_address(),
                args.vault_id,
                args.token,
                args.amount,
                args.expected_state,
                args.expected_epoch,
                args.expected_nonce,
                signer,
                args.note_id,
                args.valid_until,
                extras,
            )
        }

        fn _settle(ref self: ContractState, amount: u128) {
            let token = self.token.read();
            let locked = self.locked.read();
            assert(locked >= amount.into(), errors::LIABILITY_UNDERFLOW);
            self.locked.write(locked - amount.into());
            let approved = IERC20Dispatcher { contract_address: token }
                .approve(self.pool.read(), amount.into());
            assert(approved, errors::APPROVE_FAILED);
        }

        fn _chain_id(self: @ContractState) -> felt252 {
            get_tx_info().unbox().chain_id
        }
    }
}
