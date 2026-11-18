"use client";

import { useEffect, useState } from "react";

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * A mechanical odometer: one drum per digit, the last drum red like a real meter's.
 * On first paint it rolls up from zero; afterwards each change rolls only the drums that moved.
 */
export function Odometer({ value, digits = 6, label }: { value: number; digits?: number; label: string }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(value));
    return () => cancelAnimationFrame(id);
  }, [value]);

  const clamped = Math.min(Math.max(0, Math.floor(shown)), 10 ** digits - 1);
  const chars = String(clamped).padStart(digits, "0").split("");

  return (
    <div className="odometer" role="img" aria-label={`${label}: ${Math.floor(value).toLocaleString()}`}>
      {chars.map((c, i) => (
        <div key={i} className={`drum ${i === chars.length - 1 ? "red" : ""}`} aria-hidden>
          <div className="drum-strip" style={{ transform: `translateY(-${Number(c) * 10}%)` }}>
            {DIGITS.map((d) => (
              <span key={d}>{d}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
