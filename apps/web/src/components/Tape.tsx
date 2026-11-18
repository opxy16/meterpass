"use client";

import { formatTusd8 } from "@meterpass/sdk";
import type { FeedEvent } from "@/lib/hooks";

/** Receipt tape: every voucher the merchant accepts prints a paper slip; settlements print green. */
export function Tape({ events }: { events: FeedEvent[] }) {
  const slips = events.filter((e) => e.type === "paid" || e.type === "rejected" || e.type === "settled").slice(0, 14);
  if (slips.length === 0) {
    return (
      <p style={{ margin: "18px 0 0", color: "var(--on-enamel-2)", fontSize: 15 }}>
        Vouchers print here as an agent pays. Open the playground to start one.
      </p>
    );
  }
  return (
    <div className="tape" aria-hidden>
      {slips.map((e) => {
        if (e.type === "paid")
          return (
            <div key={`p${e.at}${e.cumulative}`} className="slip">
              <b>{formatTusd8(BigInt(e.cumulative), 3)}</b>
              pass {e.passId}, total so far
              <br />
              checked in {e.verifyMs} ms
            </div>
          );
        if (e.type === "rejected")
          return (
            <div key={`r${e.at}${e.error}`} className="slip reject">
              <b>402</b>
              {e.error.replace(/_/g, " ")}
            </div>
          );
        if (e.type === "settled")
          return (
            <div key={`s${e.hash}`} className="slip settle">
              <b>settled</b>
              {e.requests || "all"} calls, one transaction
            </div>
          );
        return null;
      })}
    </div>
  );
}
