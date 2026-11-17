// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PassVault} from "../../src/PassVault.sol";
import {AgentIdentityRegistry} from "../../src/erc8004/AgentIdentityRegistry.sol";
import {IAgentIdentity} from "../../src/interfaces/IAgentIdentity.sol";
import {MockTUSD8} from "../../src/mocks/MockTUSD8.sol";

/// @dev Drives the vault with random owners, agents, merchants, vouchers, revokes, reassignments,
/// close requests, refunds and time jumps, and keeps ghost totals for the invariants.
contract VaultHandler is Test {
    PassVault public vault;
    MockTUSD8 public usd;
    AgentIdentityRegistry public identity;

    uint256[3] internal agentPks = [uint256(0xA1), 0xA2, 0xA3];
    address[2] public merchants;
    uint256[2] public merchantIds;
    address public owner = address(0x0B0B);

    uint256[] public passIds;
    mapping(uint256 => uint128) public lastClaimed; // ghost, to check monotonicity
    mapping(uint256 => uint128) public signedUpTo; // what the agents have signed so far

    uint256 public ghostDeposited;
    uint256 public ghostPaid;
    uint256 public ghostRefunded;
    bool public monotonicBroken;

    constructor(PassVault vault_, MockTUSD8 usd_, AgentIdentityRegistry identity_) {
        vault = vault_;
        usd = usd_;
        identity = identity_;
        for (uint256 i; i < 2; ++i) {
            merchants[i] = address(uint160(0xE0 + i));
            vm.prank(merchants[i]);
            merchantIds[i] = identity.register("");
        }
        usd.mint(owner, type(uint96).max);
        vm.prank(owner);
        usd.approve(address(vault), type(uint256).max);
    }

    function passCount() external view returns (uint256) {
        return passIds.length;
    }

    function open(uint128 amount, uint8 merchantSeed, uint8 agentSeed, uint32 duration) external {
        amount = uint128(bound(amount, 1, 1_000e6));
        duration = uint32(bound(duration, 60, 30 days));
        vm.prank(owner);
        uint256 passId = vault.open(
            owner,
            merchantIds[merchantSeed % 2],
            vm.addr(agentPks[agentSeed % 3]),
            amount,
            uint64(block.timestamp + duration)
        );
        passIds.push(passId);
        ghostDeposited += amount;
    }

    function topUp(uint256 seed, uint128 amount) external {
        if (passIds.length == 0) return;
        uint256 passId = passIds[seed % passIds.length];
        if (vault.getPass(passId).closed) return;
        amount = uint128(bound(amount, 1, 100e6));
        vm.prank(owner);
        vault.topUp(passId, amount);
        ghostDeposited += amount;
    }

    /// The current agent signs a bigger cumulative voucher (maybe beyond the deposit) and anyone claims.
    function claim(uint256 seed, uint128 increment, uint8 signerSeed, bool batch) external {
        if (passIds.length == 0) return;
        uint256 passId = passIds[seed % passIds.length];
        PassVault.Pass memory p = vault.getPass(passId);
        uint128 next = signedUpTo[passId] + uint128(bound(increment, 0, p.deposit / 3 + 2));
        signedUpTo[passId] = next;
        uint256 pk = agentPks[signerSeed % 3];
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, vault.voucherDigest(passId, next));
        bytes memory sig = abi.encodePacked(r, s, v);

        uint256 before = usd.balanceOf(p.merchant);
        if (batch) {
            PassVault.Claim[] memory claims = new PassVault.Claim[](1);
            claims[0] = PassVault.Claim(passId, next, sig);
            vault.claimBatch(claims);
        } else {
            try vault.claim(passId, next, sig) {} catch {}
        }
        ghostPaid += usd.balanceOf(p.merchant) - before;

        uint128 nowClaimed = vault.getPass(passId).claimed;
        if (nowClaimed < lastClaimed[passId]) monotonicBroken = true;
        lastClaimed[passId] = nowClaimed;
    }

    function replayOld(uint256 seed) external {
        if (passIds.length == 0) return;
        uint256 passId = passIds[seed % passIds.length];
        uint128 old = lastClaimed[passId] / 2;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPks[0], vault.voucherDigest(passId, old));
        address m = vault.getPass(passId).merchant;
        uint256 before = usd.balanceOf(m);
        try vault.claim(passId, old, abi.encodePacked(r, s, v)) {} catch {}
        ghostPaid += usd.balanceOf(m) - before;
    }

    function revoke(uint256 seed) external {
        if (passIds.length == 0) return;
        uint256 passId = passIds[seed % passIds.length];
        if (vault.getPass(passId).closed) return;
        vm.prank(owner);
        vault.revoke(passId);
    }

    function reassign(uint256 seed, uint8 agentSeed) external {
        if (passIds.length == 0) return;
        uint256 passId = passIds[seed % passIds.length];
        if (vault.getPass(passId).closed) return;
        vm.prank(owner);
        vault.setAuthorizer(passId, vm.addr(agentPks[agentSeed % 3]));
    }

    function requestClose(uint256 seed) external {
        if (passIds.length == 0) return;
        uint256 passId = passIds[seed % passIds.length];
        if (vault.getPass(passId).closed) return;
        vm.prank(owner);
        vault.requestClose(passId);
    }

    function refund(uint256 seed) external {
        if (passIds.length == 0) return;
        uint256 passId = passIds[seed % passIds.length];
        PassVault.Pass memory p = vault.getPass(passId);
        if (p.closed || block.timestamp < vault.refundableAt(passId)) return;
        uint256 before = usd.balanceOf(owner);
        vm.prank(owner);
        vault.refund(passId);
        ghostRefunded += usd.balanceOf(owner) - before;
    }

    function warp(uint32 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 3 days));
    }
}

contract PassVaultInvariantTest is Test {
    PassVault internal vault;
    MockTUSD8 internal usd;
    VaultHandler internal handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        usd = new MockTUSD8();
        AgentIdentityRegistry identity = new AgentIdentityRegistry();
        vault = new PassVault(IERC20(address(usd)), IAgentIdentity(address(identity)), 1 hours);
        handler = new VaultHandler(vault, usd, identity);
        targetContract(address(handler));
    }

    /// Every token that entered is either still escrowed, paid to a merchant or refunded.
    function invariant_moneyIsConserved() public view {
        assertEq(
            handler.ghostDeposited(),
            handler.ghostPaid() + handler.ghostRefunded() + usd.balanceOf(address(vault))
        );
    }

    /// The vault always holds at least what it owes to open passes (exactly, here).
    function invariant_solvent() public view {
        assertEq(usd.balanceOf(address(vault)), vault.totalEscrowed());
    }

    /// No pass ever pays out more than was deposited into it.
    function invariant_claimsNeverExceedDeposit() public view {
        uint256 n = handler.passCount();
        for (uint256 i; i < n; ++i) {
            PassVault.Pass memory p = vault.getPass(handler.passIds(i));
            assertLe(p.claimed, p.deposit);
        }
    }

    /// Settled amounts only ever go up (replays and stale vouchers never roll them back).
    function invariant_claimedIsMonotonic() public view {
        assertFalse(handler.monotonicBroken());
    }

    /// Lifetime merchant revenue in the vault matches what merchants actually received.
    function invariant_settledVolumeMatchesPayouts() public view {
        assertEq(
            vault.settledVolume(handler.merchantIds(0)) + vault.settledVolume(handler.merchantIds(1)),
            handler.ghostPaid()
        );
    }
}
