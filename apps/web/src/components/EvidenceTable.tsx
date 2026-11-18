import { evidence, explorerTx, short } from "@/lib/config";

export function EvidenceTable() {
  if (evidence.length === 0) {
    return (
      <div className="glass pad muted" style={{ fontSize: 14 }}>
        The demo&apos;s transaction log appears here after the run on Aevum testnet.
      </div>
    );
  }
  return (
    <div className="glass table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Step</th>
            <th>Transaction</th>
            <th>Gas</th>
            <th>When (UTC)</th>
          </tr>
        </thead>
        <tbody>
          {evidence.map((e) => (
            <tr key={e.hash + e.label}>
              <td>{e.label}</td>
              <td className="mono">
                <a href={explorerTx(e.hash)} target="_blank" rel="noreferrer">
                  {short(e.hash, 6)}
                </a>
              </td>
              <td className="mono">{e.gasUsed ? Number(e.gasUsed).toLocaleString() : "–"}</td>
              <td className="mono muted">{e.at.replace("T", " ").slice(0, 19)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
