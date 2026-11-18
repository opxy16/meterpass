"use client";

import { useEffect, useRef, useState } from "react";
import { useCountUp } from "@/lib/hooks";

export function Stat(props: { label: string; value: number; decimals?: number; prefix?: string; suffix?: string; sub?: React.ReactNode; glow?: boolean }) {
  const v = useCountUp(props.value);
  const [flash, setFlash] = useState(false);
  const prev = useRef(props.value);
  useEffect(() => {
    if (props.value !== prev.current) {
      setFlash(true);
      const id = setTimeout(() => setFlash(false), 600);
      prev.current = props.value;
      return () => clearTimeout(id);
    }
  }, [props.value]);
  const d = props.decimals ?? 0;
  return (
    <div className={`glass stat ${props.glow ? "glow" : ""}`}>
      <div className="card-title">{props.label}</div>
      <div className={`value ${flash ? "flash" : ""}`}>
        {props.prefix}
        {v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}
        {props.suffix && <span className="muted" style={{ fontSize: "0.5em", marginLeft: 6 }}>{props.suffix}</span>}
      </div>
      {props.sub && <div className="sub">{props.sub}</div>}
    </div>
  );
}
