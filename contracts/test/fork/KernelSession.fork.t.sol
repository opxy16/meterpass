// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {PassVault} from "../../src/PassVault.sol";
import {AgentIdentityRegistry} from "../../src/erc8004/AgentIdentityRegistry.sol";
import {IAgentIdentity} from "../../src/interfaces/IAgentIdentity.sol";
import {MeterPassSessionValidator, PackedUserOperation} from "../../src/session/MeterPassSessionValidator.sol";
import {AevumAddresses as A} from "../../script/AevumAddresses.sol";

interface IEntryPointV07 {
    function handleOps(PackedUserOperation[] calldata ops, address payable beneficiary) external;
    function getUserOpHash(PackedUserOperation calldata userOp) external view returns (bytes32);
    function getNonce(address sender, uint192 key) external view returns (uint256);

    error FailedOp(uint256 opIndex, string reason);
    error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner);
}

interface IKernelFactory {
    function createAccount(bytes calldata data, bytes32 salt) external payable returns (address);
    function getAddress(bytes calldata data, bytes32 salt) external view returns (address);
}

/// End-to-end on a local fork of Aevum testnet: the REAL EntryPoint v0.7, Kernel v3.1 factory,
/// ECDSA root validator and tUSD8, plus freshly deployed MeterPass contracts.
/// Run with: AEVUM_FORK=1 forge test --match-path test/fork/*
contract KernelSessionForkTest is Test {
    IEntryPointV07 internal ep = IEntryPointV07(A.ENTRY_POINT_V07);
    IERC20 internal usd = IERC20(A.TUSD8);

    PassVault internal vault;
    AgentIdentityRegistry internal identity;
    MeterPassSessionValidator internal session;

    uint256 internal ownerPk = 0xA11CE;
    uint256 internal agentPk = 0xA6E47A;
    uint256 internal merchantPk = 0x3E4C;
    address internal owner;
    address internal agent;
    address internal merchant;
    uint256 internal merchantId;
    address internal account;
    bytes internal initCode;
    uint48 internal validUntil;

    function setUp() public {
        if (vm.envOr("AEVUM_FORK", uint256(0)) == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("AEVUM_RPC", string("https://rpc-test.qday.info")));
        owner = vm.addr(ownerPk);
        agent = vm.addr(agentPk);
        merchant = vm.addr(merchantPk);

        identity = new AgentIdentityRegistry();
        vault = new PassVault(usd, IAgentIdentity(address(identity)), 10 minutes);
        session = new MeterPassSessionValidator(address(vault));
        vm.prank(merchant);
        merchantId = identity.register("https://meterpass.example/merchant.json");
        validUntil = uint48(block.timestamp + 1 days);

        // Kernel v3.1 account: root = ECDSA(owner); initConfig installs the MeterPass session module
        uint256[] memory merchants = new uint256[](1);
        merchants[0] = merchantId;
        bytes memory sessionData = abi.encode(agent, owner, uint128(2e6), uint48(0), validUntil, merchants);
        bytes memory installData = abi.encodePacked(
            address(0), // no hook
            abi.encode(sessionData, bytes(""), abi.encodePacked(session.EXECUTE_SELECTOR()))
        );
        bytes[] memory initConfig = new bytes[](1);
        initConfig[0] = abi.encodeWithSignature(
            "installModule(uint256,address,bytes)", uint256(1), address(session), installData
        );
        bytes memory initData = abi.encodeWithSignature(
            "initialize(bytes21,address,bytes,bytes,bytes[])",
            bytes21(abi.encodePacked(bytes1(0x01), A.KERNEL_ECDSA_VALIDATOR)),
            address(0),
            abi.encodePacked(owner),
            bytes(""),
            initConfig
        );
        account = IKernelFactory(A.KERNEL_FACTORY_V31).getAddress(initData, bytes32(0));
        initCode = abi.encodePacked(
            A.KERNEL_FACTORY_V31, abi.encodeCall(IKernelFactory.createAccount, (initData, bytes32(0)))
        );

        // the owner funds the account: tUSD8 for passes, tQDAY for gas
        deal(address(usd), account, 5e6);
        vm.deal(account, 1 ether);
    }

    // --- helpers -------------------------------------------------------------------------------------

    function _exec(address target, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(bytes4(0xe9ae5c53), bytes32(0), abi.encodePacked(target, uint256(0), data));
    }

    function _op(uint192 key, bytes memory init, bytes memory callData) internal view returns (PackedUserOperation memory op) {
        op.sender = account;
        op.nonce = ep.getNonce(account, key);
        op.initCode = init;
        op.callData = callData;
        op.accountGasLimits = bytes32((uint256(2_000_000) << 128) | uint256(1_000_000));
        op.preVerificationGas = 100_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(2 gwei));
    }

    function _sign(PackedUserOperation memory op, uint256 pk) internal view returns (PackedUserOperation memory) {
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(ep.getUserOpHash(op));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h);
        op.signature = abi.encodePacked(r, s, v);
        return op;
    }

    function _sessionKey() internal view returns (uint192) {
        // Kernel v3 nonce key: [mode 0x00][type 0x01 = validator][validator address][2-byte key]
        return (uint192(0x01) << 176) | (uint192(uint160(address(session))) << 16);
    }

    function _handle(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        ep.handleOps(ops, payable(address(0xBEEF)));
    }

    function _setupAccount() internal {
        // ONE owner signature: deploy account + install session module + approve vault for the budget
        PackedUserOperation memory op =
            _op(0, initCode, _exec(address(usd), abi.encodeCall(IERC20.approve, (address(vault), 2e6))));
        _handle(_sign(op, ownerPk));
        assertGt(account.code.length, 0);
        assertTrue(session.isInitialized(account));
        assertEq(usd.allowance(account, address(vault)), 2e6);
    }

    // --- tests ---------------------------------------------------------------------------------------

    function test_fork_oneSignatureSetup_thenAgentOpensPass_thenBatchClaim() public {
        _setupAccount();

        // agent's session key opens a 1 tUSD8 pass, owned by the human owner
        bytes memory openCall = abi.encodeCall(
            PassVault.open, (owner, merchantId, agent, uint128(1e6), uint64(block.timestamp + 12 hours))
        );
        _handle(_sign(_op(_sessionKey(), "", _exec(address(vault), openCall)), agentPk));
        uint256 passId = vault.nextPassId() - 1;
        assertEq(vault.ownerOf(passId), owner);
        assertEq(vault.getPass(passId).payer, account);
        assertEq(session.remainingBudget(account), 1e6);

        // 250 off-chain vouchers at 0.002, one claim with the real tUSD8
        uint128 cumulative = 250 * 2_000;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, vault.voucherDigest(passId, cumulative));
        uint256 before = usd.balanceOf(merchant);
        vm.prank(merchant);
        vault.claim(passId, cumulative, abi.encodePacked(r, s, v));
        assertEq(usd.balanceOf(merchant) - before, cumulative);
    }

    function test_fork_sessionKeyCannotTransferTokens() public {
        _setupAccount();
        bytes memory steal = _exec(address(usd), abi.encodeCall(IERC20.transfer, (address(0xBAD), 1e6)));
        PackedUserOperation memory op = _sign(_op(_sessionKey(), "", steal), agentPk);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPointV07.FailedOpWithRevert.selector,
                0,
                "AA23 reverted",
                abi.encodeWithSelector(MeterPassSessionValidator.TargetNotAllowed.selector, address(usd))
            )
        );
        _handle(op);
        assertEq(usd.balanceOf(address(0xBAD)), 0);
    }

    function test_fork_sessionKeyCannotExceedBudget() public {
        _setupAccount();
        bytes memory big = abi.encodeCall(
            PassVault.open, (owner, merchantId, agent, uint128(3e6), uint64(block.timestamp + 1 hours))
        );
        PackedUserOperation memory op = _sign(_op(_sessionKey(), "", _exec(address(vault), big)), agentPk);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEntryPointV07.FailedOpWithRevert.selector,
                0,
                "AA23 reverted",
                abi.encodeWithSelector(MeterPassSessionValidator.BudgetExceeded.selector, 3e6, uint128(2e6))
            )
        );
        _handle(op);
    }

    function test_fork_ownerRevokesSession() public {
        _setupAccount();
        // owner (root validator) calls session.revokeSession() from the account
        PackedUserOperation memory rootOp =
            _op(0, "", _exec(address(session), abi.encodeCall(MeterPassSessionValidator.revokeSession, ())));
        _handle(_sign(rootOp, ownerPk));

        bytes memory openCall = abi.encodeCall(
            PassVault.open, (owner, merchantId, agent, uint128(1e5), uint64(block.timestamp + 1 hours))
        );
        PackedUserOperation memory op = _sign(_op(_sessionKey(), "", _exec(address(vault), openCall)), agentPk);
        vm.expectRevert(abi.encodeWithSelector(IEntryPointV07.FailedOp.selector, 0, "AA24 signature error"));
        _handle(op);
    }
}
