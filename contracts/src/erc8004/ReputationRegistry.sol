// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title ReputationRegistry
/// @notice A minimal ERC-8004 Reputation Registry. Clients leave signed-by-transaction feedback for an
/// agent; anyone can read a summary filtered by the clients they trust. MeterPass agents leave
/// feedback after a settlement and put the pass id in `tag2`, so every rating is tied to real paid
/// usage that anyone can check in PassVault.
contract ReputationRegistry {
    struct Feedback {
        int128 value;
        uint8 valueDecimals;
        bool isRevoked;
        string tag1;
        string tag2;
    }

    address private _identityRegistry;

    mapping(uint256 agentId => mapping(address client => Feedback[])) private _feedback;
    mapping(uint256 agentId => address[]) private _clients;
    mapping(uint256 agentId => mapping(address client => bool)) private _isClient;
    mapping(bytes32 feedbackKey => uint64) private _responseCount;

    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );
    event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);
    event ResponseAppended(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        address indexed responder,
        string responseURI,
        bytes32 responseHash
    );

    error AlreadyInitialized();
    error UnknownAgent();
    error SelfFeedback();
    error BadDecimals();
    error BadIndex();

    constructor(address identityRegistry_) {
        _identityRegistry = identityRegistry_;
    }

    function initialize(address identityRegistry_) external {
        if (_identityRegistry != address(0)) revert AlreadyInitialized();
        _identityRegistry = identityRegistry_;
    }

    function getIdentityRegistry() external view returns (address) {
        return _identityRegistry;
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        address agentOwner = _agentOwner(agentId);
        if (msg.sender == agentOwner) revert SelfFeedback();
        if (valueDecimals > 18) revert BadDecimals();
        if (!_isClient[agentId][msg.sender]) {
            _isClient[agentId][msg.sender] = true;
            _clients[agentId].push(msg.sender);
        }
        Feedback[] storage list = _feedback[agentId][msg.sender];
        list.push(Feedback(value, valueDecimals, false, tag1, tag2));
        // 1-based index, as getLastIndex returns
        _emitFeedback(agentId, uint64(list.length), value, valueDecimals, list[list.length - 1], endpoint, feedbackURI, feedbackHash);
    }

    function _emitFeedback(
        uint256 agentId,
        uint64 index,
        int128 value,
        uint8 valueDecimals,
        Feedback storage f,
        string memory endpoint,
        string memory feedbackURI,
        bytes32 feedbackHash
    ) private {
        string memory tag1 = f.tag1;
        emit NewFeedback(
            agentId, msg.sender, index, value, valueDecimals, tag1, tag1, f.tag2, endpoint, feedbackURI, feedbackHash
        );
    }

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        Feedback storage f = _at(agentId, msg.sender, feedbackIndex);
        f.isRevoked = true;
        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    function appendResponse(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        string calldata responseURI,
        bytes32 responseHash
    ) external {
        _at(agentId, clientAddress, feedbackIndex);
        _responseCount[keccak256(abi.encode(agentId, clientAddress, feedbackIndex, msg.sender))]++;
        emit ResponseAppended(agentId, clientAddress, feedbackIndex, msg.sender, responseURI, responseHash);
    }

    // --- reads -----------------------------------------------------------------------------------

    /// @notice Count and average (in 18 decimals) of non-revoked feedback from `clientAddresses`,
    /// optionally filtered by tags (empty string = no filter).
    function getSummary(
        uint256 agentId,
        address[] memory clientAddresses,
        string memory tag1,
        string memory tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals) {
        TagFilter memory filter = TagFilter({
            t1: keccak256(bytes(tag1)),
            t2: keccak256(bytes(tag2)),
            f1: bytes(tag1).length != 0,
            f2: bytes(tag2).length != 0
        });
        int256 sum;
        for (uint256 c; c < clientAddresses.length; ++c) {
            (int256 s, uint64 n) = _sumClient(_feedback[agentId][clientAddresses[c]], filter);
            sum += s;
            count += n;
        }
        if (count != 0) summaryValue = int128(sum / int256(uint256(count)));
        summaryValueDecimals = 18;
    }

    struct TagFilter {
        bytes32 t1;
        bytes32 t2;
        bool f1;
        bool f2;
    }

    function _sumClient(Feedback[] storage list, TagFilter memory filter)
        private
        view
        returns (int256 sum, uint64 count)
    {
        for (uint256 i; i < list.length; ++i) {
            Feedback storage f = list[i];
            if (f.isRevoked) continue;
            if (filter.f1 && keccak256(bytes(f.tag1)) != filter.t1) continue;
            if (filter.f2 && keccak256(bytes(f.tag2)) != filter.t2) continue;
            sum += int256(f.value) * int256(10 ** (18 - f.valueDecimals));
            count++;
        }
    }

    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked)
    {
        Feedback storage f = _at(agentId, clientAddress, feedbackIndex);
        return (f.value, f.valueDecimals, f.tag1, f.tag2, f.isRevoked);
    }

    function getResponseCount(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        address[] calldata responders
    ) external view returns (uint64 count) {
        for (uint256 i; i < responders.length; ++i) {
            count += _responseCount[keccak256(abi.encode(agentId, clientAddress, feedbackIndex, responders[i]))];
        }
    }

    function getClients(uint256 agentId) external view returns (address[] memory) {
        return _clients[agentId];
    }

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64) {
        return uint64(_feedback[agentId][clientAddress].length);
    }

    // --- internals -------------------------------------------------------------------------------

    function _agentOwner(uint256 agentId) internal view returns (address owner) {
        try IERC721(_identityRegistry).ownerOf(agentId) returns (address o) {
            owner = o;
        } catch {
            revert UnknownAgent();
        }
    }

    function _at(uint256 agentId, address client, uint64 feedbackIndex) internal view returns (Feedback storage) {
        Feedback[] storage list = _feedback[agentId][client];
        if (feedbackIndex == 0 || feedbackIndex > list.length) revert BadIndex();
        return list[feedbackIndex - 1];
    }
}
