// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./utils/Base.t.sol";
import {PassVault} from "../src/PassVault.sol";
import {
    MeterPassSessionValidator,
    PackedUserOperation,
    Execution
} from "../src/session/MeterPassSessionValidator.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Unit tests that call the validator the way Kernel does (msg.sender = the smart account).
contract SessionValidatorTest is Base {
    MeterPassSessionValidator internal validator;
    address internal account = address(0xACC0);
    uint48 internal validUntil;
    uint128 internal constant BUDGET = 2e6;
    bytes32 internal constant OP_HASH = keccak256("userOp");

    function setUp() public override {
        super.setUp();
        validator = new MeterPassSessionValidator(address(vault));
        validUntil = uint48(block.timestamp + 7 days);
        uint256[] memory merchants = new uint256[](1);
        merchants[0] = merchantId;
        vm.prank(account);
        validator.onInstall(abi.encode(agentA, owner, BUDGET, uint48(0), validUntil, merchants));
    }

    // --- helpers -------------------------------------------------------------------------------------

    function _single(address target, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(bytes4(0xe9ae5c53), bytes32(0), abi.encodePacked(target, value, data));
    }

    function _batch(Execution[] memory calls) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(bytes4(0xe9ae5c53), bytes32(uint256(1) << 248), abi.encode(calls));
    }

    function _openCall(address passOwner, uint256 mId, uint128 amount, uint64 expiry)
        internal
        view
        returns (bytes memory)
    {
        return _single(address(vault), 0, abi.encodeCall(PassVault.open, (passOwner, mId, agentA, amount, expiry)));
    }

    function _op(bytes memory callData, uint256 signerPk) internal pure returns (PackedUserOperation memory op) {
        op.callData = callData;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, MessageHashUtils.toEthSignedMessageHash(OP_HASH));
        op.signature = abi.encodePacked(r, s, v);
    }

    function _validate(bytes memory callData, uint256 signerPk) internal returns (uint256) {
        vm.prank(account);
        return validator.validateUserOp(_op(callData, signerPk), OP_HASH);
    }

    // --- allowed -------------------------------------------------------------------------------------

    function test_allowsOpenInsidePolicy_andReturnsTimeWindow() public {
        uint256 data = _validate(_openCall(owner, merchantId, 1e6, uint64(validUntil)), agentAPk);
        assertEq(data, uint256(validUntil) << 160); // sig ok, validAfter 0, validUntil packed
        assertEq(validator.remainingBudget(account), 1e6);
    }

    function test_allowsBatchOfOpenAndTopUp_countsBoth() public {
        Execution[] memory calls = new Execution[](2);
        calls[0] = Execution(
            address(vault), 0, abi.encodeCall(PassVault.open, (owner, merchantId, agentA, 5e5, uint64(validUntil)))
        );
        calls[1] = Execution(address(vault), 0, abi.encodeCall(PassVault.topUp, (1, 25e4)));
        _validate(_batch(calls), agentAPk);
        assertEq(validator.remainingBudget(account), BUDGET - 75e4);
    }

    // --- denied by policy ----------------------------------------------------------------------------

    function test_rejectsPassForSomeoneElse() public {
        bytes memory cd = _openCall(stranger, merchantId, 1e6, uint64(validUntil));
        vm.expectRevert(abi.encodeWithSelector(MeterPassSessionValidator.PassOwnerMismatch.selector, stranger));
        _validate(cd, agentAPk);
    }

    function test_rejectsMerchantNotOnAllowlist() public {
        vm.prank(stranger);
        uint256 rogueId = identity.register("");
        bytes memory cd = _openCall(owner, rogueId, 1e6, uint64(validUntil));
        vm.expectRevert(abi.encodeWithSelector(MeterPassSessionValidator.MerchantNotAllowed.selector, rogueId));
        _validate(cd, agentAPk);
    }

    function test_rejectsPassOutlivingSession() public {
        bytes memory cd = _openCall(owner, merchantId, 1e6, uint64(validUntil) + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                MeterPassSessionValidator.PassOutlivesSession.selector, uint64(validUntil) + 1, validUntil
            )
        );
        _validate(cd, agentAPk);
    }

    function test_rejectsOverBudget_acrossOperations() public {
        _validate(_openCall(owner, merchantId, 15e5, uint64(validUntil)), agentAPk);
        bytes memory cd = _openCall(owner, merchantId, 6e5, uint64(validUntil));
        vm.expectRevert(abi.encodeWithSelector(MeterPassSessionValidator.BudgetExceeded.selector, 21e5, BUDGET));
        _validate(cd, agentAPk);
    }

    /// Prompt-injection scenario: "send 5 tUSD8 to 0xBAD". The key has no way to express it.
    function test_rejectsDirectTokenTransfer() public {
        bytes memory cd = _single(address(usd), 0, abi.encodeCall(IERC20.transfer, (stranger, 5e6)));
        vm.expectRevert(abi.encodeWithSelector(MeterPassSessionValidator.TargetNotAllowed.selector, address(usd)));
        _validate(cd, agentAPk);
    }

    function test_rejectsOtherVaultFunctions() public {
        bytes memory cd = _single(address(vault), 0, abi.encodeCall(PassVault.setAuthorizer, (1, stranger)));
        vm.expectRevert(
            abi.encodeWithSelector(MeterPassSessionValidator.SelectorNotAllowed.selector, PassVault.setAuthorizer.selector)
        );
        _validate(cd, agentAPk);
    }

    function test_rejectsNativeValue() public {
        bytes memory cd = _single(address(vault), 1 wei, abi.encodeCall(PassVault.topUp, (1, 1)));
        vm.expectRevert(MeterPassSessionValidator.ValueNotAllowed.selector);
        _validate(cd, agentAPk);
    }

    function test_rejectsDelegatecallMode() public {
        bytes memory cd = abi.encodeWithSelector(
            bytes4(0xe9ae5c53), bytes32(uint256(0xff) << 248), abi.encodePacked(address(vault), bytes("x"))
        );
        vm.expectRevert();
        _validate(cd, agentAPk);
    }

    function test_rejectsOtherAccountFunctions() public {
        bytes memory cd = abi.encodeWithSignature("installModule(uint256,address,bytes)", 1, stranger, "");
        vm.expectRevert();
        _validate(cd, agentAPk);
    }

    // --- signatures, revoke, rotate, uninstall -------------------------------------------------------

    function test_wrongSignerFailsSignatureCheck() public {
        assertEq(_validate(_openCall(owner, merchantId, 1e6, uint64(validUntil)), strangerPk), 1);
    }

    function test_revokedKeyFails() public {
        vm.prank(account);
        validator.revokeSession();
        assertEq(_validate(_openCall(owner, merchantId, 1e6, uint64(validUntil)), agentAPk), 1);
    }

    function test_rotateKey() public {
        vm.prank(account);
        validator.rotateSessionKey(agentB);
        bytes memory cd = _openCall(owner, merchantId, 1e6, uint64(validUntil));
        assertEq(_validate(cd, agentAPk), 1);
        assertEq(_validate(cd, agentBPk), uint256(validUntil) << 160);
    }

    function test_uninstallForgetsAllowlist() public {
        vm.prank(account);
        validator.onUninstall("");
        assertFalse(validator.isMerchantAllowed(account, merchantId));
        uint256[] memory other = new uint256[](1);
        other[0] = 42;
        vm.prank(account);
        validator.onInstall(abi.encode(agentA, owner, BUDGET, uint48(0), validUntil, other));
        assertFalse(validator.isMerchantAllowed(account, merchantId));
        assertTrue(validator.isMerchantAllowed(account, 42));
    }

    function test_otherAccountsAreIsolated() public {
        address otherAccount = address(0xACC1);
        PackedUserOperation memory op = _op(_openCall(owner, merchantId, 1e6, uint64(validUntil)), agentAPk);
        vm.prank(otherAccount);
        assertEq(validator.validateUserOp(op, OP_HASH), 1); // not installed there
        assertEq(validator.remainingBudget(account), BUDGET);
    }

    function test_neverSignsErc1271() public view {
        assertEq(validator.isValidSignatureWithSender(address(0), bytes32(0), ""), bytes4(0xffffffff));
    }

    function testFuzz_budgetNeverExceeded(uint128[5] memory amounts) public {
        uint256 spent;
        for (uint256 i; i < amounts.length; ++i) {
            uint128 a = uint128(bound(amounts[i], 1, BUDGET));
            bytes memory cd = _openCall(owner, merchantId, a, uint64(validUntil));
            if (spent + a > BUDGET) {
                vm.expectRevert();
                _validate(cd, agentAPk);
            } else {
                _validate(cd, agentAPk);
                spent += a;
            }
            assertLe(BUDGET - validator.remainingBudget(account), BUDGET);
        }
        assertEq(BUDGET - validator.remainingBudget(account), spent);
    }
}
