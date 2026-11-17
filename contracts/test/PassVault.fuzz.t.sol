// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./utils/Base.t.sol";
import {PassVault} from "../src/PassVault.sol";

contract PassVaultFuzzTest is Base {
    /// Any increasing sequence of cumulative vouchers pays the merchant exactly the last amount.
    function testFuzz_cumulativeSequencePaysExactlyTheFinalAmount(uint128 deposit, uint64[8] memory steps) public {
        deposit = uint128(bound(deposit, 1, 900e6));
        uint256 passId = _open(deposit);
        uint128 cumulative;
        for (uint256 i; i < steps.length; ++i) {
            uint128 next = cumulative + uint128(bound(steps[i], 0, deposit / 4 + 1));
            if (next > deposit) next = deposit;
            bytes memory sig = _voucher(agentAPk, passId, next);
            if (next > cumulative) {
                vault.claim(passId, next, sig);
                cumulative = next;
            } else {
                vm.expectRevert(
                    abi.encodeWithSelector(PassVault.ClaimFailed.selector, PassVault.ClaimStatus.NothingNew)
                );
                vault.claim(passId, next, sig);
            }
        }
        assertEq(usd.balanceOf(merchant), cumulative);
        assertEq(vault.getPass(passId).claimed, cumulative);
        assertEq(vault.remaining(passId), deposit - cumulative);
    }

    /// A voucher above the deposit never settles, whatever the amounts.
    function testFuzz_cannotClaimMoreThanDeposit(uint128 deposit, uint128 over) public {
        deposit = uint128(bound(deposit, 1, 900e6));
        over = uint128(bound(over, 1, type(uint128).max - deposit));
        uint256 passId = _open(deposit);
        bytes memory sig = _voucher(agentAPk, passId, deposit + over);
        vm.expectRevert(abi.encodeWithSelector(PassVault.ClaimFailed.selector, PassVault.ClaimStatus.ExceedsDeposit));
        vault.claim(passId, deposit + over, sig);
    }

    /// Only the authorizer's key (or a recently retired one) can sign a payable voucher.
    function testFuzz_randomKeysCannotSign(uint256 pk, uint128 amount) public {
        pk = bound(pk, 1, 115792089237316195423570985008687907852837564279074904382605163141518161494336);
        vm.assume(pk != agentAPk);
        uint256 passId = _open(1e6);
        amount = uint128(bound(amount, 1, 1e6));
        bytes memory sig = _voucher(pk, passId, amount);
        vm.expectRevert(abi.encodeWithSelector(PassVault.ClaimFailed.selector, PassVault.ClaimStatus.BadSignature));
        vault.claim(passId, amount, sig);
    }

    /// Money is conserved: merchant + refund == deposits (incl. top-ups), always.
    function testFuzz_claimsPlusRefundEqualDeposits(uint128 deposit, uint128 extra, uint128 spent) public {
        deposit = uint128(bound(deposit, 1, 400e6));
        extra = uint128(bound(extra, 0, 400e6));
        uint256 passId = _open(deposit);
        if (extra > 0) {
            vm.prank(owner);
            vault.topUp(passId, extra);
        }
        uint128 total = deposit + extra;
        spent = uint128(bound(spent, 0, total));
        if (spent > 0) vault.claim(passId, spent, _voucher(agentAPk, passId, spent));

        vm.warp(vault.refundableAt(passId));
        uint256 before = usd.balanceOf(owner);
        vm.prank(owner);
        vault.refund(passId);
        assertEq(usd.balanceOf(merchant) + (usd.balanceOf(owner) - before), total);
        assertEq(usd.balanceOf(address(vault)), 0);
    }

    /// A retired key settles inside the window and never after it.
    function testFuzz_retiredKeyOnlyWithinWindow(uint64 delay) public {
        delay = uint64(bound(delay, 0, 3 * WINDOW));
        uint256 passId = _open(1e6);
        vm.prank(owner);
        vault.setAuthorizer(passId, agentB);
        vm.warp(block.timestamp + delay);
        bytes memory sig = _voucher(agentAPk, passId, 1000);
        if (delay <= WINDOW) {
            vault.claim(passId, 1000, sig);
            assertEq(usd.balanceOf(merchant), 1000);
        } else {
            vm.expectRevert(
                abi.encodeWithSelector(PassVault.ClaimFailed.selector, PassVault.ClaimStatus.BadSignature)
            );
            vault.claim(passId, 1000, sig);
        }
    }

    /// The owner can never pull funds before the merchant's settlement window has passed.
    function testFuzz_noEarlyRefund(uint64 when, bool requestClose) public {
        uint256 passId = _open(1e6);
        if (requestClose) {
            vm.prank(owner);
            vault.requestClose(passId);
        }
        uint64 at = vault.refundableAt(passId);
        when = uint64(bound(when, block.timestamp, at - 1));
        vm.warp(when);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PassVault.NotRefundableYet.selector, at));
        vault.refund(passId);
    }
}
