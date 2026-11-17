// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title AgentIdentityRegistry
/// @notice A minimal ERC-8004 ("Trustless Agents") Identity Registry, written for Aevum, where no
/// canonical ERC-8004 deployment exists yet. Each agent is an ERC-721; `agentURI` points at its
/// registration file; `agentWallet` is the address that receives payments. The wallet starts as the
/// registrant, changing it needs a signature from the new wallet, and it is cleared on transfer.
contract AgentIdentityRegistry is ERC721URIStorage, EIP712 {
    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    bytes32 public constant AGENT_WALLET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");
    string private constant RESERVED_WALLET_KEY = "agentWallet";

    uint256 private _nextAgentId = 1;
    mapping(uint256 agentId => mapping(string key => bytes value)) private _metadata;
    mapping(uint256 agentId => address wallet) private _agentWallet;

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    event MetadataSet(
        uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue
    );
    event AgentWalletSet(uint256 indexed agentId, address indexed wallet);

    error NotAgentOwner();
    error ReservedKey();
    error SignatureExpired();
    error InvalidWalletSignature();

    constructor() ERC721("ERC-8004 Agent Identity (Aevum)", "AGENT") EIP712("ERC8004IdentityRegistry", "1") {}

    // --- registration ----------------------------------------------------------------------------

    function register() external returns (uint256 agentId) {
        agentId = _register("");
    }

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = _register(agentURI);
    }

    function register(string calldata agentURI, MetadataEntry[] calldata metadata) external returns (uint256 agentId) {
        agentId = _register(agentURI);
        for (uint256 i; i < metadata.length; ++i) {
            _setMetadata(agentId, metadata[i].metadataKey, metadata[i].metadataValue);
        }
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        _onlyAgentOwner(agentId);
        _setTokenURI(agentId, newURI);
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    // --- metadata --------------------------------------------------------------------------------

    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory) {
        if (_isWalletKey(metadataKey)) return abi.encodePacked(_agentWallet[agentId]);
        return _metadata[agentId][metadataKey];
    }

    function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external {
        _onlyAgentOwner(agentId);
        _setMetadata(agentId, metadataKey, metadataValue);
    }

    // --- payment wallet --------------------------------------------------------------------------

    /// @notice Point payments at `newWallet`. `signature` is newWallet's EIP-712 (or ERC-1271) consent,
    /// so nobody can route an agent's income to an address they don't control by mistake.
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature)
        external
    {
        address owner = _onlyAgentOwner(agentId);
        if (block.timestamp > deadline) revert SignatureExpired();
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(AGENT_WALLET_TYPEHASH, agentId, newWallet, owner, deadline)));
        if (!SignatureChecker.isValidSignatureNow(newWallet, digest, signature)) revert InvalidWalletSignature();
        _agentWallet[agentId] = newWallet;
        emit AgentWalletSet(agentId, newWallet);
    }

    function unsetAgentWallet(uint256 agentId) external {
        _onlyAgentOwner(agentId);
        delete _agentWallet[agentId];
        emit AgentWalletSet(agentId, address(0));
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return _agentWallet[agentId];
    }

    function totalAgents() external view returns (uint256) {
        return _nextAgentId - 1;
    }

    function agentWalletDigest(uint256 agentId, address newWallet, address owner, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(AGENT_WALLET_TYPEHASH, agentId, newWallet, owner, deadline)));
    }

    // --- internals -------------------------------------------------------------------------------

    function _register(string memory agentURI) internal returns (uint256 agentId) {
        agentId = _nextAgentId++;
        _mint(msg.sender, agentId);
        if (bytes(agentURI).length != 0) _setTokenURI(agentId, agentURI);
        _agentWallet[agentId] = msg.sender;
        emit Registered(agentId, agentURI, msg.sender);
        emit AgentWalletSet(agentId, msg.sender);
    }

    function _setMetadata(uint256 agentId, string memory key, bytes memory value) internal {
        if (_isWalletKey(key)) revert ReservedKey();
        _metadata[agentId][key] = value;
        emit MetadataSet(agentId, key, key, value);
    }

    function _onlyAgentOwner(uint256 agentId) internal view returns (address owner) {
        owner = _requireOwned(agentId);
        if (!_isAuthorized(owner, msg.sender, agentId)) revert NotAgentOwner();
    }

    function _isWalletKey(string memory key) private pure returns (bool) {
        return keccak256(bytes(key)) == keccak256(bytes(RESERVED_WALLET_KEY));
    }

    /// @dev ERC-8004: transferring an agent clears its payment wallet.
    function _update(address to, uint256 agentId, address auth) internal override returns (address from) {
        from = super._update(to, agentId, auth);
        if (from != address(0) && to != address(0) && from != to && _agentWallet[agentId] != address(0)) {
            delete _agentWallet[agentId];
            emit AgentWalletSet(agentId, address(0));
        }
    }
}
