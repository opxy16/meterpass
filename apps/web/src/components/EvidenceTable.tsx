import { evidence, explorerTx, short } from "@/lib/config";

// The demo's own mistakes (stray accounts) stay in the JSON log for honesty but not in this summary.
const HIDE = /stray|funds smart account/i;

export function EvidenceTable() {
  const rows = evidence.filter((e) => !HIDE.test(e.label));
  if (rows.length === 0) {
    return <p className="muted">The demo's transaction log appears here after the run on Aevum testnet.</p>;
  }
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">Demo transactions on Aevum testnet</caption>
        <thead>
          <tr>
            <th scope="col">What happened</th>
            <th scope="col">Transaction</th>
            <th scope="col">Gas</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.hash + e.label}>
              <td>{e.label.charAt(0).toUpperCase() + e.label.slice(1)}</td>
              <td>
                <a href={explorerTx(e.hash)} target="_blank" rel="noreferrer">
                  {short(e.hash, 6)}
                </a>
              </td>
              <td className="num">{e.gasUsed ? Number(e.gasUsed).toLocaleString() : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
