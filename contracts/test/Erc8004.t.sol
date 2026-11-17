// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./utils/Base.t.sol";
import {AgentIdentityRegistry} from "../src/erc8004/AgentIdentityRegistry.sol";
import {ReputationRegistry} from "../src/erc8004/ReputationRegistry.sol";

contract Erc8004Test is Base {
    ReputationRegistry internal reputation;
    uint256 internal newWalletPk = 0xFA11E7;

    function setUp() public override {
        super.setUp();
        reputation = new ReputationRegistry(address(identity));
    }

    function test_register_defaultsWalletToOwner() public view {
        assertEq(identity.ownerOf(merchantId), merchant);
        assertEq(identity.getAgentWallet(merchantId), merchant);
        assertEq(identity.tokenURI(merchantId), "https://merchant.example/agent.json");
    }

    function test_registerWithMetadata_andReservedKey() public {
        AgentIdentityRegistry.MetadataEntry[] memory md = new AgentIdentityRegistry.MetadataEntry[](1);
        md[0] = AgentIdentityRegistry.MetadataEntry("x402.scheme", bytes("batch-settlement"));
        vm.prank(stranger);
        uint256 id = identity.register("ipfs://card", md);
        assertEq(string(identity.getMetadata(id, "x402.scheme")), "batch-settlement");

        vm.prank(stranger);
        vm.expectRevert(AgentIdentityRegistry.ReservedKey.selector);
        identity.setMetadata(id, "agentWallet", abi.encodePacked(stranger));
    }

    function test_setAgentWallet_needsNewWalletSignature() public {
        address newWallet = vm.addr(newWalletPk);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = identity.agentWalletDigest(merchantId, newWallet, merchant, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(newWalletPk, digest);

        vm.prank(merchant);
        identity.setAgentWallet(merchantId, newWallet, deadline, abi.encodePacked(r, s, v));
        assertEq(identity.getAgentWallet(merchantId), newWallet);

        // a signature from someone else is refused
        (v, r, s) = vm.sign(strangerPk, identity.agentWalletDigest(merchantId, stranger, merchant, deadline));
        vm.prank(merchant);
        identity.setAgentWallet(merchantId, stranger, deadline, abi.encodePacked(r, s, v));
        bytes memory wrong = abi.encodePacked(r, s, v);
        vm.prank(merchant);
        vm.expectRevert(AgentIdentityRegistry.InvalidWalletSignature.selector);
        identity.setAgentWallet(merchantId, newWallet, deadline, wrong);
    }

    function test_transferClearsWallet_soPassesCannotOpen() public {
        vm.prank(merchant);
        identity.transferFrom(merchant, stranger, merchantId);
        assertEq(identity.getAgentWallet(merchantId), address(0));
        vm.prank(owner);
        vm.expectRevert();
        vault.open(owner, merchantId, agentA, 1e6, uint64(block.timestamp + 1 days));
    }

    function test_reputation_feedbackTiedToPass() public {
        uint256 passId = _open(1e6);
        vault.claim(passId, 500_000, _voucher(agentAPk, passId, 500_000));

        vm.prank(owner);
        reputation.giveFeedback(merchantId, 95, 0, "meterpass", "pass:1", "https://api.example/v1", "", bytes32(0));
        address[] memory clients = new address[](1);
        clients[0] = owner;
        (uint64 count, int128 value, uint8 decimals) = reputation.getSummary(merchantId, clients, "meterpass", "");
        assertEq(count, 1);
        assertEq(value, 95e18);
        assertEq(decimals, 18);
        assertEq(reputation.getLastIndex(merchantId, owner), 1);
        assertEq(passId, 1);

        vm.prank(owner);
        reputation.revokeFeedback(merchantId, 1);
        (count,,) = reputation.getSummary(merchantId, clients, "", "");
        assertEq(count, 0);
    }

    function test_reputation_noSelfFeedback() public {
        vm.prank(merchant);
        vm.expectRevert(ReputationRegistry.SelfFeedback.selector);
        reputation.giveFeedback(merchantId, 100, 0, "", "", "", "", bytes32(0));
    }
}
