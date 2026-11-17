// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @dev ERC-4337 v0.7 packed user operation.
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

/// @dev ERC-7579 batch item, as Kernel v3 encodes it.
struct Execution {
    address target;
    uint256 value;
    bytes callData;
}

/// @title MeterPassSessionValidator
/// @notice A scoped session key for Kernel v3.1 smart accounts (an ERC-7579 validator module).
///
/// The owner installs it once (one signature) with: the agent's session key, the owner address that
/// must receive every pass NFT, a total tUSD8 budget, a validity window and an allowlist of ERC-8004
/// merchant agent ids. After that the agent can, on its own, only:
///   - PassVault.open(owner = passOwner, merchant in allowlist, expiry <= validUntil, amount)
///   - PassVault.topUp(passId, amount)
/// with no ETH value, while the running total stays within the budget, inside the time window.
/// It cannot call the token, cannot send funds anywhere, cannot sign ERC-1271 messages for the
/// account, and the owner can revoke or rotate it at any time.
///
/// Validation reads and writes only storage keyed by the account (ERC-7562 "associated storage")
/// and uses no TIMESTAMP opcode: the time window is returned in validationData for the EntryPoint.
contract MeterPassSessionValidator {
    struct Session {
        address sessionKey; // 0 = revoked / not installed
        uint48 validAfter;
        uint48 validUntil; // 0 = no end (not recommended)
        address passOwner;
        uint64 epoch;
        uint128 budget;
        uint128 spent;
    }

    uint256 internal constant MODULE_TYPE_VALIDATOR = 1;
    uint256 internal constant SIG_VALIDATION_FAILED = 1;
    bytes4 internal constant ERC1271_INVALID = 0xffffffff;
    /// @dev Kernel v3 / ERC-7579 `execute(bytes32 mode, bytes executionCalldata)`.
    bytes4 public constant EXECUTE_SELECTOR = 0xe9ae5c53;
    bytes32 internal constant MODE_SINGLE = bytes32(0);
    bytes32 internal constant MODE_BATCH = bytes32(uint256(0x01) << 248);

    bytes4 internal constant OPEN_SELECTOR = bytes4(keccak256("open(address,uint256,address,uint128,uint64)"));
    bytes4 internal constant TOPUP_SELECTOR = bytes4(keccak256("topUp(uint256,uint128)"));

    address public immutable vault;

    mapping(address account => Session) internal _sessions;
    mapping(address account => uint64) internal _epochOf;
    /// @dev agentId => account => epoch in which the merchant was allowed (account is the inner key
    /// so the slot counts as storage associated with the account).
    mapping(uint256 merchantAgentId => mapping(address account => uint64)) internal _allowedIn;

    event SessionInstalled(
        address indexed account,
        address indexed sessionKey,
        address passOwner,
        uint128 budget,
        uint48 validAfter,
        uint48 validUntil
    );
    event MerchantAllowed(address indexed account, uint256 indexed merchantAgentId);
    event SessionKeyChanged(address indexed account, address indexed previous, address indexed next);
    event SessionSpent(address indexed account, uint128 amount, uint128 totalSpent);
    event SessionUninstalled(address indexed account);

    error AlreadyInstalled();
    error InvalidConfig();
    error CallNotAllowed(bytes4 reason);
    error TargetNotAllowed(address target);
    error ValueNotAllowed();
    error SelectorNotAllowed(bytes4 selector);
    error PassOwnerMismatch(address owner);
    error MerchantNotAllowed(uint256 merchantAgentId);
    error PassOutlivesSession(uint64 expiry, uint48 validUntil);
    error BudgetExceeded(uint256 wouldSpend, uint128 budget);
    error NotInstalled();

    constructor(address vault_) {
        if (vault_ == address(0)) revert InvalidConfig();
        vault = vault_;
    }

    // ---------------------------------------------------------------------------------------------
    // ERC-7579 module lifecycle (called by the account)
    // ---------------------------------------------------------------------------------------------

    /// @param data abi.encode(sessionKey, passOwner, budget, validAfter, validUntil, uint256[] merchantAgentIds)
    function onInstall(bytes calldata data) external payable {
        if (_sessions[msg.sender].sessionKey != address(0)) revert AlreadyInstalled();
        (
            address sessionKey,
            address passOwner,
            uint128 budget,
            uint48 validAfter,
            uint48 validUntil,
            uint256[] memory merchants
        ) = abi.decode(data, (address, address, uint128, uint48, uint48, uint256[]));
        if (sessionKey == address(0) || passOwner == address(0) || budget == 0 || merchants.length == 0) {
            revert InvalidConfig();
        }
        if (validUntil != 0 && validUntil <= validAfter) revert InvalidConfig();

        uint64 epoch = ++_epochOf[msg.sender];
        _sessions[msg.sender] = Session({
            sessionKey: sessionKey,
            validAfter: validAfter,
            validUntil: validUntil,
            passOwner: passOwner,
            epoch: epoch,
            budget: budget,
            spent: 0
        });
        for (uint256 i; i < merchants.length; ++i) {
            _allowedIn[merchants[i]][msg.sender] = epoch;
            emit MerchantAllowed(msg.sender, merchants[i]);
        }
        emit SessionInstalled(msg.sender, sessionKey, passOwner, budget, validAfter, validUntil);
    }

    function onUninstall(bytes calldata) external payable {
        delete _sessions[msg.sender];
        ++_epochOf[msg.sender]; // invalidates the old merchant allowlist without iterating it
        emit SessionUninstalled(msg.sender);
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_VALIDATOR;
    }

    function isInitialized(address account) external view returns (bool) {
        return _sessions[account].sessionKey != address(0);
    }

    // ---------------------------------------------------------------------------------------------
    // Owner controls (the account calls these through its root validator)
    // ---------------------------------------------------------------------------------------------

    /// @notice Kill switch: the session key can no longer act for this account.
    function revokeSession() external {
        Session storage s = _sessions[msg.sender];
        if (s.sessionKey == address(0)) revert NotInstalled();
        emit SessionKeyChanged(msg.sender, s.sessionKey, address(0));
        s.sessionKey = address(0);
    }

    /// @notice Swap the agent key, keeping budget, spend and allowlist.
    function rotateSessionKey(address next) external {
        Session storage s = _sessions[msg.sender];
        if (s.passOwner == address(0)) revert NotInstalled();
        if (next == address(0)) revert InvalidConfig();
        emit SessionKeyChanged(msg.sender, s.sessionKey, next);
        s.sessionKey = next;
    }

    // ---------------------------------------------------------------------------------------------
    // Validation
    // ---------------------------------------------------------------------------------------------

    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash)
        external
        payable
        returns (uint256 validationData)
    {
        Session storage s = _sessions[msg.sender];
        address key = s.sessionKey;
        if (key == address(0)) return SIG_VALIDATION_FAILED;

        // 1. policy: every call must be an allowed PassVault call; count the tUSD8 it commits
        uint256 spend = _checkCallData(msg.sender, s, userOp.callData);
        uint256 total = uint256(s.spent) + spend;
        if (total > s.budget) revert BudgetExceeded(total, s.budget);
        s.spent = uint128(total);
        emit SessionSpent(msg.sender, uint128(spend), uint128(total));

        // 2. signature by the session key over the userOp hash
        (address recovered, ECDSA.RecoverError err,) =
            ECDSA.tryRecover(MessageHashUtils.toEthSignedMessageHash(userOpHash), userOp.signature);
        if (err != ECDSA.RecoverError.NoError || recovered != key) return SIG_VALIDATION_FAILED;

        // 3. time window, enforced by the EntryPoint
        return (uint256(s.validUntil) << 160) | (uint256(s.validAfter) << 208);
    }

    /// @notice Session keys never sign ERC-1271 messages for the account.
    function isValidSignatureWithSender(address, bytes32, bytes calldata) external pure returns (bytes4) {
        return ERC1271_INVALID;
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function getSession(address account) external view returns (Session memory) {
        return _sessions[account];
    }

    function isMerchantAllowed(address account, uint256 merchantAgentId) public view returns (bool) {
        uint64 epoch = _sessions[account].epoch;
        return epoch != 0 && _allowedIn[merchantAgentId][account] == epoch;
    }

    function remainingBudget(address account) external view returns (uint128) {
        Session storage s = _sessions[account];
        return s.budget - s.spent;
    }

    /// @notice Dry-run the policy on account callData (for UIs and agents). Reverts with the reason.
    function checkCallData(address account, bytes calldata callData) external view returns (uint256 spend) {
        return _checkCallData(account, _sessions[account], callData);
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    function _checkCallData(address account, Session storage s, bytes calldata callData)
        internal
        view
        returns (uint256 spend)
    {
        if (callData.length < 4 || bytes4(callData[0:4]) != EXECUTE_SELECTOR) {
            revert CallNotAllowed(callData.length < 4 ? bytes4(0) : bytes4(callData[0:4]));
        }
        (bytes32 mode, bytes memory exec) = abi.decode(callData[4:], (bytes32, bytes));
        if (mode == MODE_SINGLE) {
            if (exec.length < 56) revert CallNotAllowed(bytes4(0));
            address target;
            uint256 value;
            assembly {
                target := shr(96, mload(add(exec, 32)))
                value := mload(add(exec, 52))
            }
            bytes memory inner = new bytes(exec.length - 52);
            for (uint256 i; i < inner.length; ++i) {
                inner[i] = exec[i + 52];
            }
            spend = _checkCall(account, s, target, value, inner);
        } else if (mode == MODE_BATCH) {
            Execution[] memory calls = abi.decode(exec, (Execution[]));
            for (uint256 i; i < calls.length; ++i) {
                spend += _checkCall(account, s, calls[i].target, calls[i].value, calls[i].callData);
            }
        } else {
            revert CallNotAllowed(bytes4(mode));
        }
    }

    function _checkCall(address account, Session storage s, address target, uint256 value, bytes memory data)
        internal
        view
        returns (uint256 amount)
    {
        if (value != 0) revert ValueNotAllowed();
        if (target != vault) revert TargetNotAllowed(target);
        if (data.length < 4) revert SelectorNotAllowed(bytes4(0));
        bytes4 selector;
        assembly {
            selector := mload(add(data, 32))
        }
        bytes memory args = new bytes(data.length - 4);
        for (uint256 i; i < args.length; ++i) {
            args[i] = data[i + 4];
        }
        if (selector == OPEN_SELECTOR) {
            (address owner, uint256 merchantAgentId,, uint128 amt, uint64 expiry) =
                abi.decode(args, (address, uint256, address, uint128, uint64));
            if (owner != s.passOwner) revert PassOwnerMismatch(owner);
            if (!isMerchantAllowed(account, merchantAgentId)) revert MerchantNotAllowed(merchantAgentId);
            if (s.validUntil != 0 && expiry > s.validUntil) revert PassOutlivesSession(expiry, s.validUntil);
            return amt;
        }
        if (selector == TOPUP_SELECTOR) {
            (, uint128 amt) = abi.decode(args, (uint256, uint128));
            return amt;
        }
        revert SelectorNotAllowed(selector);
    }
}
