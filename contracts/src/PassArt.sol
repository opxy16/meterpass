// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice Fully on-chain metadata + SVG for a MeterPass NFT. The card shows live state:
/// remaining credit, a usage bar, the merchant agent and the pass status.
library PassArt {
    using Strings for uint256;

    struct Data {
        uint256 passId;
        uint256 merchantAgentId;
        uint128 deposit;
        uint128 claimed;
        uint64 expiry;
        bool closed;
        bool revoked;
    }

    function tokenURI(Data memory d) internal view returns (string memory) {
        string memory status = _status(d);
        string memory head = string.concat(
            '{"name":"MeterPass #',
            d.passId.toString(),
            '","description":"Prepaid tUSD8 credit for one ERC-8004 merchant on QDay Aevum. An AI agent spends it with off-chain vouchers; the merchant settles many calls in one transaction.",'
        );
        string memory attrs = string.concat(
            '"attributes":[{"trait_type":"Status","value":"',
            status,
            '"},{"trait_type":"Merchant agent","value":',
            d.merchantAgentId.toString(),
            '},{"trait_type":"Deposit (tUSD8)","value":"',
            _fmt(d.deposit),
            '"},'
        );
        attrs = string.concat(
            attrs,
            '{"trait_type":"Settled (tUSD8)","value":"',
            _fmt(d.claimed),
            '"},{"display_type":"date","trait_type":"Expiry","value":',
            uint256(d.expiry).toString(),
            "}],"
        );
        string memory image =
            string.concat('"image":"data:image/svg+xml;base64,', Base64.encode(bytes(_svg(d, status))), '"}');
        return string.concat("data:application/json;base64,", Base64.encode(bytes(string.concat(head, attrs, image))));
    }

    function _status(Data memory d) private view returns (string memory) {
        if (d.closed) return "Closed";
        if (d.revoked) return "Paused";
        if (block.timestamp > d.expiry) return "Expired";
        return "Active";
    }

    function _svg(Data memory d, string memory status) private pure returns (string memory) {
        uint256 left = d.deposit - d.claimed;
        uint256 barWidth = d.deposit == 0 ? 0 : (uint256(d.claimed) * 300) / d.deposit;
        string memory top = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220" viewBox="0 0 360 220">',
            '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f172a"/>',
            '<stop offset="1" stop-color="#312e81"/></linearGradient></defs>',
            '<rect width="360" height="220" rx="22" fill="url(#g)"/>',
            '<text x="30" y="44" fill="#a5b4fc" font-family="monospace" font-size="13">METERPASS #',
            d.passId.toString(),
            '</text><text x="330" y="44" text-anchor="end" fill="#e0e7ff" font-family="monospace" font-size="13">',
            status
        );
        string memory mid = string.concat(
            '</text><text x="30" y="104" fill="#ffffff" font-family="sans-serif" font-size="34" font-weight="700">',
            _fmt(uint128(left)),
            '</text><text x="30" y="128" fill="#c7d2fe" font-family="sans-serif" font-size="13">tUSD8 credit left of ',
            _fmt(d.deposit),
            '</text><rect x="30" y="148" width="300" height="8" rx="4" fill="#1e1b4b"/>'
        );
        string memory bottom = string.concat(
            '<rect x="30" y="148" width="',
            barWidth.toString(),
            '" height="8" rx="4" fill="#818cf8"/>',
            '<text x="30" y="192" fill="#a5b4fc" font-family="monospace" font-size="12">merchant agent ',
            d.merchantAgentId.toString(),
            " | eip155:44005</text></svg>"
        );
        return string.concat(top, mid, bottom);
    }

    /// @dev 6-decimal amount to "1.2345" (4 decimals, truncated).
    function _fmt(uint128 amount) internal pure returns (string memory) {
        uint256 whole = amount / 1e6;
        uint256 frac = (amount % 1e6) / 100;
        bytes memory f = bytes(frac.toString());
        bytes memory padded = new bytes(4);
        for (uint256 i; i < 4; ++i) {
            padded[i] = i < 4 - f.length ? bytes1("0") : f[i - (4 - f.length)];
        }
        return string.concat(whole.toString(), ".", string(padded));
    }
}
