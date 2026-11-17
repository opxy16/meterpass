// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base} from "./utils/Base.t.sol";
import {PassVault} from "../src/PassVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAgentIdentity} from "../src/interfaces/IAgentIdentity.sol";

contract PassVaultTest is Base {
    // --- opening -----------------------------------------------------------------------------------

    function test_open_escrowsAndMints() public {
        uint256 passId = _open(1e6);
        assertEq(vault.ownerOf(passId), owner);
        assertEq(usd.balanceOf(address(vault)), 1e6);
        assertEq(vault.totalEscrowed(), 1e6);
        PassVault.Pass memory p = vault.getPass(passId);
        assertEq(p.merchant, merchant);
        assertEq(p.authorizer, agentA);
        assertEq(p.payer, owner);
        assertEq(p.merchantAgentId, merchantId);
        assertEq(p.deposit, 1e6);
    }

    function test_open_revertsForUnregisteredMerchant() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PassVault.MerchantNotRegistered.selector, 99));
        vault.open(owner, 99, agentA, 1e6, uint64(block.timestamp + 1 days));
    }

    function test_open_revertsWhenAuthorizerIsMerchant() public {
        vm.prank(owner);
        vm.expectRevert(PassVault.AuthorizerIsMerchant.selector);
        vault.open(owner, merchantId, merchant, 1e6, uint64(block.timestamp + 1 days));
    }

    function test_open_revertsOnBadExpiry() public {
        vm.startPrank(owner);
        vm.expectRevert(PassVault.BadExpiry.selector);
        vault.open(owner, merchantId, agentA, 1e6, uint64(block.timestamp));
        vm.expectRevert(PassVault.BadExpiry.selector);
        vault.open(owner, merchantId, agentA, 1e6, uint64(block.timestamp + 366 days));
        vm.stopPrank();
    }

    // --- the core loop: 250 vouchers, one claim ------------------------------------------------------

    function test_250Calls_oneClaim() public {
        uint256 passId = _open(1e6);
        bytes memory latest;
        uint128 cumulative;
        for (uint256 i; i < 250; ++i) {
            cumulative += PRICE;
            latest = _voucher(agentAPk, passId, cumulative); // off-chain in real life
        }
        assertEq(cumulative, 500_000); // 250 x 0.002 = 0.5 tUSD8

        uint256 gasBefore = gasleft();
        vm.prank(merchant);
        uint128 paid = vault.claim(passId, cumulative, latest);
        emit log_named_uint("gas for one claim settling 250 calls", gasBefore - gasleft());

        assertEq(paid, 500_000);
        assertEq(usd.balanceOf(merchant), 500_000);
        assertEq(vault.remaining(passId), 500_000);
        assertEq(vault.settledVolume(merchantId), 500_000);
    }

    function test_claim_paysOnlyTheDelta() public {
        uint256 passId = _open(1e6);
        vault.claim(passId, 100_000, _voucher(agentAPk, passId, 100_000));
        vault.claim(passId, 250_000, _voucher(agentAPk, passId, 250_000));
        assertEq(usd.balanceOf(merchant), 250_000);
    }

    function test_claim_replayPaysNothing() public {
        uint256 passId = _open(1e6);
        bytes memory sig = _voucher(agentAPk, passId, 100_000);
        vault.claim(passId, 100_000, sig);
        vm.expectRevert(abi.encodeWithSelector(PassVault.ClaimFailed.selector, PassVault.ClaimStatus.NothingNew));
        vault.claim(passId, 100_000, sig);
    }

    function test_claim_olderVoucherAfterNewerPaysNothing() public {
        uint256 passId = _open(1e6);
        bytes memory older = _voucher(agentAPk, passId, 100_000);
        vault.claim(passId, 200_000, _voucher(agentAPk, passId, 200_000));
        vm.expectRevert(abi.encodeWithSelector(PassVault.ClaimFailed.selector, PassVault.ClaimStatus.NothingNew));
        vault.claim(passId, 100_000, older);
    }

    function test_claim_cannotExceedDeposit() public {
        uint256 passId = _open(1e6);
        bytes memory sig_ = _voucher(agentAPk, passId, 1e6 + 1);
        vm.expectRevert(abi.encodeWithSelector(PassVault.ClaimFailed.selector, PassVault.ClaimStatus.ExceedsDeposit));
        vault.claim(passId, 1e6 + 1, sig_);
    }

    function test_claim_rejectsStrangerSignature() public {
        uint256 passId = _open(1e6);
        bytes memory sig_ = _voucher(strangerPk, passId, 1000);
        vm.expectRevert(abi.encodeWithSelector(PassVault.ClaimFailed.selector, PassVault.ClaimStatus.BadSignature));
        vault.claim(passId, 1000, sig_);
    }

    function test_claim_voucherBoundToPass() public {
        uint256 p1 = _open(1e6);
        uint256 p2 = _open(1e6);
        bytes memory forP1 = _voucher(agentAPk, p1, 1000);
        vm.expectRevert(abi.encodeWithSelector(PassVault.ClaimFailed.selector, PassVault.ClaimStatus.BadSignature));
        vault.claim(p2, 1000, forP1);
    }

    function test_claim_voucherBoundToVaultAndChain() public {
        uint256 passId = _open(1e6);
        // Same pass id on a second vault: the EIP-712 domain differs, so the voucher is useless there.
        PassVault other = new PassVault(IERC20(address(usd)), IAgentIdentity(address(identity)), WINDOW);
        vm.prank(owner);
        usd.approve(address(other), type(uint256).max);
        vm.prank(owner);
        other.open(owner, merchantId, agentA, 1e6, uint64(block.timestamp + 1 days));
        bytes memory sig = _voucher(agentAPk, passId, 1000);
        vm.expectRevert(abi.encodeWithSelector(PassVault.ClaimFailed.selector, PassVault.ClaimStatus.BadSignature));
        other.claim(passId, 1000, sig);

        // Same vault, different chain id: digest changes.
        bytes32 here = vault.voucherDigest(passId, 1000);
        vm.chainId(1);
        assertTrue(vault.voucherDigest(passId, 1000) != here);
    }

    function test_claim_anyoneCanSubmit_moneyGoesToMerchant() public {
        uint256 passId = _open(1e6);
        vm.prank(stranger);
        vault.claim(passId, 5000, _voucher(agentAPk, passId, 5000));
        assertEq(usd.balanceOf(merchant), 5000);
        assertEq(usd.balanceOf(stranger), 0);
    }

    // --- batch settlement ----------------------------------------------------------------------------

    function test_claimBatch_manyPassesOneTransfer_skipsBadOnes() public {
        uint256 p1 = _open(1e6);
        uint256 p2 = _open(1e6);
        uint256 p3 = _open(1e6);
        PassVault.Claim[] memory claims = new PassVault.Claim[](4);
        claims[0] = PassVault.Claim(p1, 10_000, _voucher(agentAPk, p1, 10_000));
        claims[1] = PassVault.Claim(p2, 20_000, _voucher(strangerPk, p2, 20_000)); // bad signature
        claims[2] = PassVault.Claim(p3, 30_000, _voucher(agentAPk, p3, 30_000));
        claims[3] = PassVault.Claim(999, 1, hex"00"); // unknown pass

        vm.expectEmit(true, false, false, true);
        emit PassVault.ClaimSkipped(p2, PassVault.ClaimStatus.BadSignature);
        uint256 total = vault.claimBatch(claims);
        assertEq(total, 40_000);
        assertEq(usd.balanceOf(merchant), 40_000);
        assertEq(vault.getPass(p2).claimed, 0);
    }

    // --- revoke, rotate, reassign --------------------------------------------------------------------

    function test_revoke_newKeyVouchersDie_oldOnesSettleWithinWindow() public {
        uint256 passId = _open(1e6);
        bytes memory beforeRevoke = _voucher(agentAPk, passId, 40_000);
        vm.prank(owner);
        vault.revoke(passId);
        assertEq(vault.getPass(passId).authorizer, address(0));
        assertTrue(vault.isValidSigner(passId, agentA)); // still inside the settlement window

        // merchant settles work already served
        vault.claim(passId, 40_000, beforeRevoke);
        assertEq(usd.balanceOf(merchant), 40_000);

        // after the window the retired key is worthless
        vm.warp(block.timestamp + WINDOW + 1);
        assertFalse(vault.isValidSigner(passId, agentA));
        bytes memory sig_ = _voucher(agentAPk, passId, 80_000);
        vm.expectRevert(abi.encodeWithSelector(PassVault.ClaimFailed.selector, PassVault.ClaimStatus.BadSignature));
        vault.claim(passId, 80_000, sig_);
    }

    function test_reassign_toAgentB_continuesCumulative() public {
        uint256 passId = _open(1e6);
        bytes memory aLast = _voucher(agentAPk, passId, 100_000);
        vm.expectEmit(true, true, true, true);
        emit PassVault.AuthorizerChanged(passId, agentA, agentB);
        vm.prank(owner);
        vault.setAuthorizer(passId, agentB);

        // B continues from A's last cumulative; merchant settles both in order
        bytes memory bLast = _voucher(agentBPk, passId, 160_000);
        vault.claim(passId, 100_000, aLast);
        vault.claim(passId, 160_000, bLast);
        assertEq(usd.balanceOf(merchant), 160_000);
    }

    function test_onlyOwnerControlsPass() public {
        uint256 passId = _open(1e6);
        vm.startPrank(agentA); // the agent itself cannot change its own powers
        vm.expectRevert(PassVault.NotPassOwner.selector);
        vault.setAuthorizer(passId, agentB);
        vm.expectRevert(PassVault.NotPassOwner.selector);
        vault.revoke(passId);
        vm.expectRevert(PassVault.NotPassOwner.selector);
        vault.requestClose(passId);
        vm.stopPrank();
    }

    function test_transferRetiresAgent() public {
        uint256 passId = _open(1e6);
        vm.prank(owner);
        vault.transferFrom(owner, stranger, passId);
        assertEq(vault.getPass(passId).authorizer, address(0));
        vm.prank(stranger);
        vault.setAuthorizer(passId, agentB);
        assertEq(vault.getPass(passId).authorizer, agentB);
    }

    // --- top-ups -------------------------------------------------------------------------------------

    function test_topUp_onlyOwnerOrPayer() public {
        uint256 passId = _open(1e6);
        vm.prank(owner);
        vault.topUp(passId, 5e5);
        assertEq(vault.getPass(passId).deposit, 15e5);

        usd.mint(stranger, 1e6);
        vm.startPrank(stranger);
        usd.approve(address(vault), 1e6);
        vm.expectRevert(PassVault.NotFunder.selector);
        vault.topUp(passId, 1e6);
        vm.stopPrank();
    }

    // --- refunds and the withdraw delay --------------------------------------------------------------

    function test_refund_onlyAfterExpiryPlusWindow() public {
        uint256 passId = _open(1e6);
        vault.claim(passId, 300_000, _voucher(agentAPk, passId, 300_000));
        uint64 expiry = vault.getPass(passId).expiry;

        vm.warp(expiry);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PassVault.NotRefundableYet.selector, expiry + WINDOW));
        vault.refund(passId);

        // merchant can still settle during the window after expiry
        vault.claim(passId, 320_000, _voucher(agentAPk, passId, 320_000));

        vm.warp(expiry + WINDOW);
        uint256 before = usd.balanceOf(owner);
        vm.prank(owner);
        uint128 back = vault.refund(passId);
        assertEq(back, 680_000);
        assertEq(usd.balanceOf(owner) - before, 680_000);
        assertEq(vault.totalEscrowed(), 0);
        assertTrue(vault.getPass(passId).closed);

        bytes memory sig_ = _voucher(agentAPk, passId, 400_000);

        vm.expectRevert(abi.encodeWithSelector(PassVault.ClaimFailed.selector, PassVault.ClaimStatus.Closed));

        vault.claim(passId, 400_000, sig_);
    }

    function test_requestClose_refundAfterWindow() public {
        uint256 passId = _open(1e6);
        vm.prank(owner);
        vault.requestClose(passId);
        assertEq(vault.refundableAt(passId), block.timestamp + WINDOW);
        vm.warp(block.timestamp + WINDOW);
        vm.prank(owner);
        assertEq(vault.refund(passId), 1e6);
    }

    // --- one-signature open (EIP-3009) ---------------------------------------------------------------

    function _openRequest() internal view returns (PassVault.OpenRequest memory req) {
        req = PassVault.OpenRequest({
            owner: owner,
            merchantAgentId: merchantId,
            authorizer: agentA,
            amount: 1e6,
            expiry: uint64(block.timestamp + 1 days),
            salt: keccak256("demo")
        });
    }

    function _sign3009(PassVault.OpenRequest memory req, uint256 validBefore)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                usd.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                req.owner,
                address(vault),
                uint256(req.amount),
                uint256(0),
                validBefore,
                vault.openAuthNonce(req)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usd.DOMAIN_SEPARATOR(), structHash));
        return vm.sign(ownerPk, digest);
    }

    function test_openWithAuthorization_oneSignature() public {
        PassVault.OpenRequest memory req = _openRequest();
        (uint8 v, bytes32 r, bytes32 s) = _sign3009(req, block.timestamp + 1 hours);
        vm.prank(merchant); // a relayer pays the gas; the owner only signed
        uint256 passId = vault.openWithAuthorization(req, 0, block.timestamp + 1 hours, v, r, s);
        assertEq(vault.ownerOf(passId), owner);
        assertEq(vault.getPass(passId).deposit, 1e6);
    }

    function test_openWithAuthorization_relayerCannotChangeTerms() public {
        PassVault.OpenRequest memory req = _openRequest();
        (uint8 v, bytes32 r, bytes32 s) = _sign3009(req, block.timestamp + 1 hours);
        req.authorizer = stranger; // try to swap in an attacker's agent key
        vm.expectRevert();
        vault.openWithAuthorization(req, 0, block.timestamp + 1 hours, v, r, s);
    }

    function test_openWithAuthorization_cannotReplay() public {
        PassVault.OpenRequest memory req = _openRequest();
        (uint8 v, bytes32 r, bytes32 s) = _sign3009(req, block.timestamp + 1 hours);
        vault.openWithAuthorization(req, 0, block.timestamp + 1 hours, v, r, s);
        vm.expectRevert();
        vault.openWithAuthorization(req, 0, block.timestamp + 1 hours, v, r, s);
    }

    // --- metadata ------------------------------------------------------------------------------------

    function test_tokenURI_isOnchainJson() public {
        uint256 passId = _open(1e6);
        vault.claim(passId, 250_000, _voucher(agentAPk, passId, 250_000));
        string memory uri = vault.tokenURI(passId);
        assertEq(bytes(uri).length > 200, true);
        assertEq(_startsWith(uri, "data:application/json;base64,"), true);
    }

    function _startsWith(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(prefix);
        if (a.length < b.length) return false;
        for (uint256 i; i < b.length; ++i) {
            if (a[i] != b[i]) return false;
        }
        return true;
    }
}
