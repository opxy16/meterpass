// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PassVault} from "../../src/PassVault.sol";
import {AgentIdentityRegistry} from "../../src/erc8004/AgentIdentityRegistry.sol";
import {IAgentIdentity} from "../../src/interfaces/IAgentIdentity.sol";
import {MockTUSD8} from "../../src/mocks/MockTUSD8.sol";

abstract contract Base is Test {
    uint64 internal constant WINDOW = 1 hours;
    uint128 internal constant PRICE = 2_000; // 0.002 tUSD8

    MockTUSD8 internal usd;
    AgentIdentityRegistry internal identity;
    PassVault internal vault;

    uint256 internal ownerPk = 0xA11CE;
    uint256 internal agentAPk = 0xA6E47A;
    uint256 internal agentBPk = 0xA6E47B;
    uint256 internal merchantPk = 0x3E4C;
    uint256 internal strangerPk = 0xBAD;
    address internal owner;
    address internal agentA;
    address internal agentB;
    address internal merchant;
    address internal stranger;
    uint256 internal merchantId;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        owner = vm.addr(ownerPk);
        agentA = vm.addr(agentAPk);
        agentB = vm.addr(agentBPk);
        merchant = vm.addr(merchantPk);
        stranger = vm.addr(strangerPk);

        usd = new MockTUSD8();
        identity = new AgentIdentityRegistry();
        vault = new PassVault(IERC20(address(usd)), IAgentIdentity(address(identity)), WINDOW);

        vm.prank(merchant);
        merchantId = identity.register("https://merchant.example/agent.json");

        usd.mint(owner, 1_000e6);
        vm.prank(owner);
        usd.approve(address(vault), type(uint256).max);
    }

    function _open(uint128 amount) internal returns (uint256 passId) {
        vm.prank(owner);
        passId = vault.open(owner, merchantId, agentA, amount, uint64(block.timestamp + 1 days));
    }

    function _voucher(uint256 pk, uint256 passId, uint128 cumulative) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, vault.voucherDigest(passId, cumulative));
        return abi.encodePacked(r, s, v);
    }
}
