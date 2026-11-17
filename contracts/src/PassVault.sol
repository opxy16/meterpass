// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {IAgentIdentity} from "./interfaces/IAgentIdentity.sol";
import {PassArt} from "./PassArt.sol";

/// @title PassVault
/// @notice MeterPass: pay per request without a transaction per request.
///
/// A pass is an ERC-721 that escrows tUSD8 for ONE merchant (an ERC-8004 registered agent).
/// The pass names an `authorizer`, normally an AI agent's session key. For every API call the
/// authorizer signs an off-chain EIP-712 voucher carrying the CUMULATIVE amount owed so far.
/// Vouchers cost no gas and verify in microseconds. Whenever it likes, the merchant submits the
/// latest voucher and is paid the difference since its last claim: hundreds of calls, one tx.
///
/// Safety properties (each one is a Foundry test or invariant):
///  - a claim can never move more than the pass deposit, in total, ever;
///  - vouchers are cumulative and bound to this chain + this vault (EIP-712 domain), so replaying
///    or reordering them pays nothing extra;
///  - the owner can revoke or rotate the authorizer at any time; vouchers signed by a retired key
///    stay claimable only for `settlementWindow`, so honest merchants are paid for work already
///    done while a leaked key stops being useful;
///  - unused credit is refunded to the owner, but only `settlementWindow` after expiry or after a
///    close request, so the merchant always has time to settle first (withdraw delay > claim interval).
contract PassVault is ERC721, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    struct Pass {
        address merchant; // payout wallet, snapshot of the merchant agent's ERC-8004 agentWallet at open
        uint64 expiry; // vouchers are honoured until here; refund opens at expiry + settlementWindow
        address authorizer; // current voucher signer; address(0) = revoked
        uint64 closeRequestedAt; // 0 = no early close requested
        bool closed; // refunded and finished
        address payer; // who funded the pass at open; may top it up
        uint96 merchantAgentId; // ERC-8004 agentId of the merchant
        uint128 deposit; // total tUSD8 ever deposited
        uint128 claimed; // total tUSD8 ever paid to the merchant (== highest settled voucher)
    }

    struct OpenRequest {
        address owner; // receives the pass NFT and pays the deposit
        uint256 merchantAgentId;
        address authorizer;
        uint128 amount;
        uint64 expiry;
        bytes32 salt; // makes otherwise identical requests distinct
    }

    struct Claim {
        uint256 passId;
        uint128 cumulativeAmount;
        bytes signature;
    }

    enum ClaimStatus {
        Paid,
        NothingNew,
        ExceedsDeposit,
        BadSignature,
        Closed,
        UnknownPass
    }

    // ---------------------------------------------------------------------------------------------
    // Constants & immutables
    // ---------------------------------------------------------------------------------------------

    bytes32 public constant VOUCHER_TYPEHASH = keccak256("Voucher(uint256 passId,uint128 cumulativeAmount)");
    bytes32 public constant OPEN_REQUEST_TYPEHASH = keccak256(
        "OpenRequest(address owner,uint256 merchantAgentId,address authorizer,uint128 amount,uint64 expiry,bytes32 salt)"
    );
    uint64 public constant MAX_DURATION = 365 days;

    IERC20 public immutable token;
    IAgentIdentity public immutable identity;
    /// @notice Time a merchant has to settle after a revoke, a close request or expiry.
    uint64 public immutable settlementWindow;

    // ---------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------

    uint256 public nextPassId = 1;
    mapping(uint256 passId => Pass) internal _passes;
    /// @notice When a signer stopped being the pass authorizer (0 = never retired).
    mapping(uint256 passId => mapping(address signer => uint64)) public retiredAt;
    /// @notice Lifetime tUSD8 settled to each merchant agent: verifiable revenue for ERC-8004 reputation.
    mapping(uint256 merchantAgentId => uint256) public settledVolume;
    /// @notice Tokens held for open passes. Invariant: token.balanceOf(this) >= totalEscrowed.
    uint256 public totalEscrowed;

    // ---------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------

    event PassOpened(
        uint256 indexed passId,
        address indexed owner,
        uint256 indexed merchantAgentId,
        address merchant,
        address authorizer,
        address payer,
        uint128 amount,
        uint64 expiry
    );
    event ToppedUp(uint256 indexed passId, address indexed from, uint128 amount, uint128 newDeposit);
    event AuthorizerChanged(uint256 indexed passId, address indexed previous, address indexed next);
    event ExpiryExtended(uint256 indexed passId, uint64 newExpiry);
    event CloseRequested(uint256 indexed passId, uint64 refundableAt);
    event Claimed(
        uint256 indexed passId,
        address indexed merchant,
        address indexed signer,
        uint128 cumulativeAmount,
        uint128 paid
    );
    event ClaimSkipped(uint256 indexed passId, ClaimStatus status);
    event Refunded(uint256 indexed passId, address indexed to, uint128 amount);

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    error ZeroAmount();
    error ZeroAddress();
    error BadExpiry();
    error MerchantNotRegistered(uint256 merchantAgentId);
    error AuthorizerIsMerchant();
    error NotPassOwner();
    error NotFunder();
    error PassClosed();
    error UnknownPass();
    error ClaimFailed(ClaimStatus status);
    error NotRefundableYet(uint64 refundableAt);
    error AmountTooLarge();

    constructor(IERC20 token_, IAgentIdentity identity_, uint64 settlementWindow_)
        ERC721("MeterPass", "MPASS")
        EIP712("MeterPass", "1")
    {
        if (address(token_) == address(0) || address(identity_) == address(0)) revert ZeroAddress();
        if (settlementWindow_ == 0) revert BadExpiry();
        token = token_;
        identity = identity_;
        settlementWindow = settlementWindow_;
    }

    // ---------------------------------------------------------------------------------------------
    // Opening and funding
    // ---------------------------------------------------------------------------------------------

    /// @notice Open a pass funded by msg.sender (needs an ERC-20 allowance). Used by smart accounts
    /// through a scoped session key, and by anyone with a plain wallet.
    function open(address owner, uint256 merchantAgentId, address authorizer, uint128 amount, uint64 expiry)
        external
        nonReentrant
        returns (uint256 passId)
    {
        passId = _open(owner, merchantAgentId, authorizer, amount, expiry, msg.sender);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Open a pass with ONE owner signature and no owner gas: the owner signs an EIP-3009
    /// ReceiveWithAuthorization whose nonce is `openAuthNonce(req)`. That binds the signature to
    /// every pass parameter (merchant, authorizer, amount, expiry), so a relayer cannot change them.
    function openWithAuthorization(
        OpenRequest calldata req,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 passId) {
        passId = _open(req.owner, req.merchantAgentId, req.authorizer, req.amount, req.expiry, req.owner);
        IERC3009(address(token)).receiveWithAuthorization(
            req.owner, address(this), req.amount, validAfter, validBefore, openAuthNonce(req), v, r, s
        );
    }

    /// @notice Add credit to a pass. Only its owner or its original payer may top it up, so a stolen
    /// session key cannot route the owner's budget into somebody else's pass.
    function topUp(uint256 passId, uint128 amount) external nonReentrant {
        Pass storage p = _existing(passId);
        if (p.closed) revert PassClosed();
        if (msg.sender != p.payer && msg.sender != _ownerOf(passId)) revert NotFunder();
        if (amount == 0) revert ZeroAmount();
        uint256 newDeposit = uint256(p.deposit) + amount;
        if (newDeposit > type(uint128).max) revert AmountTooLarge();
        p.deposit = uint128(newDeposit);
        totalEscrowed += amount;
        emit ToppedUp(passId, msg.sender, amount, uint128(newDeposit));
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Owner controls
    // ---------------------------------------------------------------------------------------------

    /// @notice Hand the pass to another agent (or rotate the key). The old key retires: its vouchers
    /// stay claimable for `settlementWindow`, then die.
    function setAuthorizer(uint256 passId, address next) external {
        Pass storage p = _ownedOpen(passId);
        if (next != address(0) && next == p.merchant) revert AuthorizerIsMerchant();
        _setAuthorizer(passId, p, next);
    }

    /// @notice Instant stop: the merchant's very next request check sees address(0) and answers 402.
    function revoke(uint256 passId) external {
        Pass storage p = _ownedOpen(passId);
        _setAuthorizer(passId, p, address(0));
    }

    function extendExpiry(uint256 passId, uint64 newExpiry) external {
        Pass storage p = _ownedOpen(passId);
        if (newExpiry <= p.expiry || newExpiry > block.timestamp + MAX_DURATION) revert BadExpiry();
        p.expiry = newExpiry;
        emit ExpiryExtended(passId, newExpiry);
    }

    /// @notice Ask to close before expiry. Refund opens `settlementWindow` later.
    function requestClose(uint256 passId) external {
        Pass storage p = _ownedOpen(passId);
        if (p.closeRequestedAt == 0) p.closeRequestedAt = uint64(block.timestamp);
        emit CloseRequested(passId, refundableAt(passId));
    }

    /// @notice Return unused credit to the pass owner and close the pass. The NFT stays as a receipt.
    function refund(uint256 passId) external nonReentrant returns (uint128 amount) {
        Pass storage p = _ownedOpen(passId);
        uint64 at = refundableAt(passId);
        if (block.timestamp < at) revert NotRefundableYet(at);
        amount = p.deposit - p.claimed;
        p.closed = true;
        if (p.authorizer != address(0)) _setAuthorizer(passId, p, address(0));
        totalEscrowed -= amount;
        address to = _ownerOf(passId);
        emit Refunded(passId, to, amount);
        if (amount != 0) token.safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------------------------------

    /// @notice Settle one voucher. Anyone may submit; the money always goes to the pass merchant.
    function claim(uint256 passId, uint128 cumulativeAmount, bytes calldata signature)
        external
        nonReentrant
        returns (uint128 paid)
    {
        ClaimStatus status;
        address merchant;
        (status, paid, merchant) = _settle(passId, cumulativeAmount, signature);
        if (status != ClaimStatus.Paid) revert ClaimFailed(status);
        token.safeTransfer(merchant, paid);
    }

    /// @notice Settle many passes in one transaction. Invalid entries are skipped (and logged) instead
    /// of reverting the batch, so one stale voucher never blocks the rest. Consecutive claims for the
    /// same merchant are paid with a single transfer.
    function claimBatch(Claim[] calldata claims) external nonReentrant returns (uint256 totalPaid) {
        address pendingTo;
        uint256 pendingAmount;
        for (uint256 i; i < claims.length; ++i) {
            (ClaimStatus status, uint128 paid, address merchant) =
                _settle(claims[i].passId, claims[i].cumulativeAmount, claims[i].signature);
            if (status != ClaimStatus.Paid) {
                emit ClaimSkipped(claims[i].passId, status);
                continue;
            }
            totalPaid += paid;
            if (merchant != pendingTo) {
                if (pendingAmount != 0) token.safeTransfer(pendingTo, pendingAmount);
                pendingTo = merchant;
                pendingAmount = 0;
            }
            pendingAmount += paid;
        }
        if (pendingAmount != 0) token.safeTransfer(pendingTo, pendingAmount);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function getPass(uint256 passId) external view returns (Pass memory) {
        return _passes[passId];
    }

    /// @notice Unclaimed credit still in the pass.
    function remaining(uint256 passId) external view returns (uint128) {
        Pass storage p = _passes[passId];
        return p.closed ? 0 : p.deposit - p.claimed;
    }

    function refundableAt(uint256 passId) public view returns (uint64) {
        Pass storage p = _passes[passId];
        uint64 start = p.expiry;
        if (p.closeRequestedAt != 0 && p.closeRequestedAt < start) start = p.closeRequestedAt;
        return start + settlementWindow;
    }

    /// @notice True if `signer` may sign vouchers that will settle right now.
    function isValidSigner(uint256 passId, address signer) public view returns (bool) {
        Pass storage p = _passes[passId];
        if (signer == address(0)) return false;
        if (signer == p.authorizer) return true;
        uint64 r = retiredAt[passId][signer];
        return r != 0 && block.timestamp <= uint256(r) + settlementWindow;
    }

    function voucherDigest(uint256 passId, uint128 cumulativeAmount) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VOUCHER_TYPEHASH, passId, cumulativeAmount)));
    }

    /// @notice Dry-run a claim: what it would pay and why not, if not.
    function previewClaim(uint256 passId, uint128 cumulativeAmount, bytes calldata signature)
        external
        view
        returns (ClaimStatus status, uint128 payable_, address signer)
    {
        Pass storage p = _passes[passId];
        if (p.merchant == address(0)) return (ClaimStatus.UnknownPass, 0, address(0));
        if (p.closed) return (ClaimStatus.Closed, 0, address(0));
        if (cumulativeAmount <= p.claimed) return (ClaimStatus.NothingNew, 0, address(0));
        if (cumulativeAmount > p.deposit) return (ClaimStatus.ExceedsDeposit, 0, address(0));
        signer = _voucherSigner(passId, p, voucherDigest(passId, cumulativeAmount), signature);
        if (signer == address(0)) return (ClaimStatus.BadSignature, 0, address(0));
        return (ClaimStatus.Paid, cumulativeAmount - p.claimed, signer);
    }

    /// @notice The EIP-3009 nonce an owner must sign to open `req` with `openWithAuthorization`.
    function openAuthNonce(OpenRequest calldata req) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    OPEN_REQUEST_TYPEHASH,
                    req.owner,
                    req.merchantAgentId,
                    req.authorizer,
                    req.amount,
                    req.expiry,
                    req.salt
                )
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function tokenURI(uint256 passId) public view override returns (string memory) {
        _requireOwned(passId);
        Pass storage p = _passes[passId];
        return PassArt.tokenURI(
            PassArt.Data({
                passId: passId,
                merchantAgentId: p.merchantAgentId,
                deposit: p.deposit,
                claimed: p.claimed,
                expiry: p.expiry,
                closed: p.closed,
                revoked: p.authorizer == address(0)
            })
        );
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _open(
        address owner,
        uint256 merchantAgentId,
        address authorizer,
        uint128 amount,
        uint64 expiry,
        address payer
    ) internal returns (uint256 passId) {
        if (owner == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_DURATION) revert BadExpiry();
        if (merchantAgentId > type(uint96).max) revert MerchantNotRegistered(merchantAgentId);
        address merchant = _merchantWallet(merchantAgentId);
        if (authorizer != address(0) && authorizer == merchant) revert AuthorizerIsMerchant();

        passId = nextPassId++;
        _passes[passId] = Pass({
            merchant: merchant,
            expiry: expiry,
            authorizer: authorizer,
            closeRequestedAt: 0,
            closed: false,
            payer: payer,
            merchantAgentId: uint96(merchantAgentId),
            deposit: amount,
            claimed: 0
        });
        totalEscrowed += amount;
        _mint(owner, passId);
        emit PassOpened(passId, owner, merchantAgentId, merchant, authorizer, payer, amount, expiry);
        if (authorizer != address(0)) emit AuthorizerChanged(passId, address(0), authorizer);
    }

    function _merchantWallet(uint256 merchantAgentId) internal view returns (address merchant) {
        try identity.getAgentWallet(merchantAgentId) returns (address w) {
            merchant = w;
        } catch {
            revert MerchantNotRegistered(merchantAgentId);
        }
        if (merchant == address(0)) revert MerchantNotRegistered(merchantAgentId);
    }

    function _settle(uint256 passId, uint128 cumulativeAmount, bytes calldata signature)
        internal
        returns (ClaimStatus, uint128 paid, address merchant)
    {
        Pass storage p = _passes[passId];
        merchant = p.merchant;
        if (merchant == address(0)) return (ClaimStatus.UnknownPass, 0, merchant);
        if (p.closed) return (ClaimStatus.Closed, 0, merchant);
        uint128 alreadyClaimed = p.claimed;
        if (cumulativeAmount <= alreadyClaimed) return (ClaimStatus.NothingNew, 0, merchant);
        if (cumulativeAmount > p.deposit) return (ClaimStatus.ExceedsDeposit, 0, merchant);
        address signer = _voucherSigner(passId, p, voucherDigest(passId, cumulativeAmount), signature);
        if (signer == address(0)) return (ClaimStatus.BadSignature, 0, merchant);

        paid = cumulativeAmount - alreadyClaimed;
        p.claimed = cumulativeAmount;
        totalEscrowed -= paid;
        settledVolume[p.merchantAgentId] += paid;
        emit Claimed(passId, merchant, signer, cumulativeAmount, paid);
        return (ClaimStatus.Paid, paid, merchant);
    }

    /// @dev Returns the signer if the voucher signature is valid for this pass right now, else 0.
    /// The current authorizer may be an EOA or an ERC-1271 contract; retired keys are EOAs only.
    function _voucherSigner(uint256 passId, Pass storage p, bytes32 digest, bytes calldata signature)
        internal
        view
        returns (address)
    {
        address current = p.authorizer;
        if (current != address(0) && SignatureChecker.isValidSignatureNow(current, digest, signature)) {
            return current;
        }
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered == current) return address(0);
        return isValidSigner(passId, recovered) ? recovered : address(0);
    }

    function _setAuthorizer(uint256 passId, Pass storage p, address next) internal {
        address previous = p.authorizer;
        if (previous == next) return;
        if (previous != address(0)) retiredAt[passId][previous] = uint64(block.timestamp);
        if (next != address(0)) delete retiredAt[passId][next];
        p.authorizer = next;
        emit AuthorizerChanged(passId, previous, next);
    }

    function _existing(uint256 passId) internal view returns (Pass storage p) {
        p = _passes[passId];
        if (p.merchant == address(0)) revert UnknownPass();
    }

    function _ownedOpen(uint256 passId) internal view returns (Pass storage p) {
        p = _existing(passId);
        address owner = _ownerOf(passId);
        if (!_isAuthorized(owner, msg.sender, passId)) revert NotPassOwner();
        if (p.closed) revert PassClosed();
    }

    /// @dev Selling or gifting the pass retires its agent: the new owner picks their own.
    function _update(address to, uint256 passId, address auth) internal override returns (address from) {
        from = super._update(to, passId, auth);
        if (from != address(0) && to != address(0) && from != to) {
            Pass storage p = _passes[passId];
            if (p.authorizer != address(0)) _setAuthorizer(passId, p, address(0));
        }
    }
}
