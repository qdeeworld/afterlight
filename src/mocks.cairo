// Test doubles for the decisive pool/helper boundary. MockPrivacyPool follows
// the deployed pool's order: helper call -> strict OpenNoteDeposit decode ->
// exact transfer_from pull. These contracts are not deployable dependencies.

use starknet::ContractAddress;

#[starknet::interface]
pub trait IMockPrivacyPool<T> {
    fn create_open_note(ref self: T, note_id: felt252, token: ContractAddress);
    fn transfer_to(ref self: T, token: ContractAddress, recipient: ContractAddress, amount: u256);
    fn invoke_external(
        ref self: T, target: ContractAddress, calldata: Span<felt252>, expected_deposits: u32,
    );
    fn note_amount(self: @T, note_id: felt252) -> u128;
}

#[starknet::contract]
pub mod MockPrivacyPool {
    use core::num::traits::Zero;
    use starknet::storage::{
        Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use starknet::syscalls::call_contract_syscall;
    use starknet::{ContractAddress, SyscallResultTrait, get_contract_address};
    use crate::common::OpenNoteDeposit;

    #[starknet::interface]
    trait IERC20<T> {
        fn transfer(ref self: T, recipient: ContractAddress, amount: u256) -> bool;
        fn transfer_from(
            ref self: T, sender: ContractAddress, recipient: ContractAddress, amount: u256,
        ) -> bool;
    }

    #[storage]
    struct Storage {
        note_token: Map<felt252, ContractAddress>,
        note_deposited: Map<felt252, u128>,
        note_exists: Map<felt252, bool>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        ExternalContractInvoked: ExternalContractInvoked,
        OpenNoteDeposited: OpenNoteDeposited,
    }

    #[derive(Drop, PartialEq, starknet::Event)]
    pub struct ExternalContractInvoked {
        pub contract_address: ContractAddress,
        pub selector: felt252,
    }

    #[derive(Drop, PartialEq, starknet::Event)]
    pub struct OpenNoteDeposited {
        pub depositor: ContractAddress,
        pub token: ContractAddress,
        pub note_id: felt252,
        pub amount: u128,
    }

    #[abi(embed_v0)]
    impl MockPoolImpl of super::IMockPrivacyPool<ContractState> {
        fn create_open_note(ref self: ContractState, note_id: felt252, token: ContractAddress) {
            assert(note_id != 0, 'ZERO_NOTE');
            assert(!self.note_exists.entry(note_id).read(), 'NOTE_EXISTS');
            self.note_token.entry(note_id).write(token);
            self.note_exists.entry(note_id).write(true);
        }

        fn transfer_to(
            ref self: ContractState,
            token: ContractAddress,
            recipient: ContractAddress,
            amount: u256,
        ) {
            let ok = IERC20Dispatcher { contract_address: token }.transfer(recipient, amount);
            assert(ok, 'TRANSFER_FAILED');
        }

        fn invoke_external(
            ref self: ContractState,
            target: ContractAddress,
            calldata: Span<felt252>,
            expected_deposits: u32,
        ) {
            let mut return_data = call_contract_syscall(
                address: target, entry_point_selector: selector!("privacy_invoke"), :calldata,
            )
                .unwrap_syscall();
            self
                .emit(
                    ExternalContractInvoked {
                        contract_address: target, selector: selector!("privacy_invoke"),
                    },
                );

            let deposits: Span<OpenNoteDeposit> = Serde::deserialize(ref return_data)
                .expect('INVALID_INVOKE_RETURN');
            assert(return_data.is_empty(), 'INVALID_INVOKE_RETURN');
            assert(deposits.len() == expected_deposits, 'UNDEPOSITED_OPEN_NOTES');

            for deposit in deposits {
                let OpenNoteDeposit { note_id, token, amount } = *deposit;
                assert(token.is_non_zero(), 'ZERO_TOKEN');
                assert(amount.is_non_zero(), 'ZERO_AMOUNT');
                assert(self.note_exists.entry(note_id).read(), 'NOTE_NOT_FOUND');
                assert(
                    self.note_deposited.entry(note_id).read().is_zero(), 'NOTE_ALREADY_DEPOSITED',
                );
                assert(self.note_token.entry(note_id).read() == token, 'TOKEN_MISMATCH');
                self.note_deposited.entry(note_id).write(amount);
                let ok = IERC20Dispatcher { contract_address: token }
                    .transfer_from(target, get_contract_address(), amount.into());
                assert(ok, 'TRANSFER_FROM_FAILED');
                self.emit(OpenNoteDeposited { depositor: target, token, note_id, amount });
            }
        }

        fn note_amount(self: @ContractState, note_id: felt252) -> u128 {
            self.note_deposited.entry(note_id).read()
        }
    }
}

#[starknet::interface]
pub trait IMockERC20<T> {
    fn mint(ref self: T, recipient: ContractAddress, amount: u256);
    fn balance_of(self: @T, account: ContractAddress) -> u256;
    fn allowance(self: @T, owner: ContractAddress, spender: ContractAddress) -> u256;
    fn transfer(ref self: T, recipient: ContractAddress, amount: u256) -> bool;
    fn transfer_from(
        ref self: T, sender: ContractAddress, recipient: ContractAddress, amount: u256,
    ) -> bool;
    fn approve(ref self: T, spender: ContractAddress, amount: u256) -> bool;
    fn set_fail_approve(ref self: T, fail: bool);
    fn set_fail_transfer(ref self: T, fail: bool);
    fn set_fail_transfer_from(ref self: T, fail: bool);
}

#[starknet::contract]
pub mod MockERC20 {
    use starknet::storage::{
        Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address};

    #[storage]
    struct Storage {
        balances: Map<ContractAddress, u256>,
        allowances: Map<(ContractAddress, ContractAddress), u256>,
        fail_approve: bool,
        fail_transfer: bool,
        fail_transfer_from: bool,
    }

    #[abi(embed_v0)]
    impl MockERC20Impl of super::IMockERC20<ContractState> {
        fn mint(ref self: ContractState, recipient: ContractAddress, amount: u256) {
            let current = self.balances.entry(recipient).read();
            self.balances.entry(recipient).write(current + amount);
        }

        fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            self.balances.entry(account).read()
        }

        fn allowance(
            self: @ContractState, owner: ContractAddress, spender: ContractAddress,
        ) -> u256 {
            self.allowances.entry((owner, spender)).read()
        }

        fn transfer(ref self: ContractState, recipient: ContractAddress, amount: u256) -> bool {
            if self.fail_transfer.read() {
                return false;
            }
            let caller = get_caller_address();
            let balance = self.balances.entry(caller).read();
            if balance < amount {
                return false;
            }
            self.balances.entry(caller).write(balance - amount);
            let recipient_balance = self.balances.entry(recipient).read();
            self.balances.entry(recipient).write(recipient_balance + amount);
            true
        }

        fn transfer_from(
            ref self: ContractState,
            sender: ContractAddress,
            recipient: ContractAddress,
            amount: u256,
        ) -> bool {
            if self.fail_transfer_from.read() {
                return false;
            }
            let caller = get_caller_address();
            let allowed = self.allowances.entry((sender, caller)).read();
            let balance = self.balances.entry(sender).read();
            if allowed < amount || balance < amount {
                return false;
            }
            self.allowances.entry((sender, caller)).write(allowed - amount);
            self.balances.entry(sender).write(balance - amount);
            let recipient_balance = self.balances.entry(recipient).read();
            self.balances.entry(recipient).write(recipient_balance + amount);
            true
        }

        fn approve(ref self: ContractState, spender: ContractAddress, amount: u256) -> bool {
            if self.fail_approve.read() {
                return false;
            }
            self.allowances.entry((get_caller_address(), spender)).write(amount);
            true
        }

        fn set_fail_approve(ref self: ContractState, fail: bool) {
            self.fail_approve.write(fail);
        }

        fn set_fail_transfer(ref self: ContractState, fail: bool) {
            self.fail_transfer.write(fail);
        }

        fn set_fail_transfer_from(ref self: ContractState, fail: bool) {
            self.fail_transfer_from.write(fail);
        }
    }
}
