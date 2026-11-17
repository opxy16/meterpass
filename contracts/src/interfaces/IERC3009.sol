// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The EIP-3009 subset MeterPass uses. tUSD8 on Aevum implements it (USDC-style, domain version "2").
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
