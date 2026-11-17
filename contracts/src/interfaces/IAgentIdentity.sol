// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The part of an ERC-8004 Identity Registry that PassVault reads.
interface IAgentIdentity {
    function ownerOf(uint256 agentId) external view returns (address);
    function getAgentWallet(uint256 agentId) external view returns (address);
}
