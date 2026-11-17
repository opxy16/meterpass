// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PassVault} from "../src/PassVault.sol";
import {AgentIdentityRegistry} from "../src/erc8004/AgentIdentityRegistry.sol";
import {ReputationRegistry} from "../src/erc8004/ReputationRegistry.sol";
import {IAgentIdentity} from "../src/interfaces/IAgentIdentity.sol";
import {MeterPassSessionValidator} from "../src/session/MeterPassSessionValidator.sol";
import {MockTUSD8} from "../src/mocks/MockTUSD8.sol";
import {AevumAddresses as A} from "./AevumAddresses.sol";

/// Deploys MeterPass with CREATE2 (through the deterministic deployer at 0x4e59...956C), so the
/// addresses depend only on the salt and the code.
///
///   DEPLOYER_PRIVATE_KEY   from .env.wallets (never printed)
///   SETTLEMENT_WINDOW      seconds, default 300 on testnet (use ~1 day in production)
///   SALT                   default keccak256("meterpass.v1")
///
/// Aevum: forge script script/Deploy.s.sol --rpc-url aevum --broadcast --legacy --slow
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint64 window = uint64(vm.envOr("SETTLEMENT_WINDOW", uint256(300)));
        bytes32 salt = vm.envOr("SALT", keccak256("meterpass.v1"));
        bool isAevum = block.chainid == A.CHAIN_ID;
        uint256 startBlock = block.number;

        vm.startBroadcast(pk);
        address token = isAevum ? A.TUSD8 : vm.envOr("TOKEN", address(0));
        if (token == address(0)) token = address(new MockTUSD8{salt: salt}());

        AgentIdentityRegistry identity = new AgentIdentityRegistry{salt: salt}();
        ReputationRegistry reputation = new ReputationRegistry{salt: salt}(address(identity));
        PassVault vault =
            new PassVault{salt: salt}(IERC20(token), IAgentIdentity(address(identity)), window);
        MeterPassSessionValidator session = new MeterPassSessionValidator{salt: salt}(address(vault));
        vm.stopBroadcast();

        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "startBlock", startBlock);
        vm.serializeUint(k, "settlementWindow", window);
        vm.serializeBytes32(k, "salt", salt);
        vm.serializeAddress(k, "token", token);
        vm.serializeAddress(k, "identityRegistry", address(identity));
        vm.serializeAddress(k, "reputationRegistry", address(reputation));
        vm.serializeAddress(k, "passVault", address(vault));
        vm.serializeAddress(k, "sessionValidator", address(session));
        vm.serializeAddress(k, "entryPoint", A.ENTRY_POINT_V07);
        vm.serializeAddress(k, "kernelFactory", A.KERNEL_FACTORY_V31);
        string memory json = vm.serializeAddress(k, "kernelEcdsaValidator", A.KERNEL_ECDSA_VALIDATOR);
        string memory path = string.concat("../deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);

        console2.log("token              ", token);
        console2.log("identityRegistry   ", address(identity));
        console2.log("reputationRegistry ", address(reputation));
        console2.log("passVault          ", address(vault));
        console2.log("sessionValidator   ", address(session));
        console2.log("written to         ", path);
    }
}
