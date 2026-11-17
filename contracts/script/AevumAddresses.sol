// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Infrastructure already live on QDay Aevum testnet (chain 44005). Verified on-chain 2026-11-17.
library AevumAddresses {
    uint256 internal constant CHAIN_ID = 44005;
    address internal constant TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;
    address internal constant ENTRY_POINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address internal constant KERNEL_V31_IMPL = 0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D;
    address internal constant KERNEL_FACTORY_V31 = 0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419;
    address internal constant KERNEL_ECDSA_VALIDATOR = 0x845ADb2C711129d4f3966735eD98a9F09fC4cE57;
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
}
