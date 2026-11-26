import { useEffect, useMemo, useState } from "react";
import { useAccount, useConfig, usePublicClient } from "wagmi";
import { simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { parseEventLogs, type Abi, type Address, type Hex, type TransactionReceipt } from "viem";
import type { Deployment } from "./deployment";
import { ConnectControl, explainError, switchToChain } from "./wallet";
import { fmt, parseAmount, short, utc } from "./format";
import { encodeExactInSingle, minOut, quoterAbi, universalRouterAbi } from "./uniswap";
import { loadPool } from "./pool";

const ZERO = "0x0000000000000000000000000000000000000000";
const QUOTE_TTL_MS = 30_000;

type Tx =
  | { phase: "idle" }
  | { phase: "simulating" | "wallet"; label: string }
  | { phase: "pending"; label: string; hash: Hex }
  | { phase: "done"; hash: Hex; message: string }
  | { phase: "failed"; message: string; hash?: Hex };

/** Simulate, send, wait for the receipt, and report what the receipt shows. Never reports the simulation's result. */
function useTx(d: Deployment) {
  const config = useConfig();
  const qc = useQueryClient();
  const [tx, setTx] = useState<Tx>({ phase: "idle" });
  const busy = tx.phase === "simulating" || tx.phase === "wallet" || tx.phase === "pending";
  async function run(
    label: string,
    params: Parameters<typeof simulateContract>[1],
    describe: (r: TransactionReceipt) => Promise<string> | string,
    onRevertName?: (name: string | undefined) => void,
  ) {
    let hash: Hex | undefined;
    try {
      setTx({ phase: "simulating", label });
      const { request } = await simulateContract(config, { ...params, chainId: d.chain.id } as never);
      setTx({ phase: "wallet", label });
      hash = await writeContract(config, request as never);
      setTx({ phase: "pending", label, hash });
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: d.chain.id });
      await qc.invalidateQueries();
      if (receipt.status !== "success") {
        setTx({ phase: "failed", hash, message: `The transaction reverted in block ${receipt.blockNumber}. Nothing changed.` });
        return;
      }
      setTx({ phase: "done", hash, message: await describe(receipt) });
    } catch (e) {
      const ex = explainError(e);
      onRevertName?.(ex.name);
      if (ex.name === "AlreadyClaimed" || ex.name === "UnknownGift") await qc.invalidateQueries();
      setTx({ phase: "failed", hash, message: ex.text });
    }
  }
  return { tx, busy, run, reset: () => setTx({ phase: "idle" }) };
}

function TxStatus({ tx, d }: { tx: Tx; d: Deployment }) {
  const link = (h: Hex) => (
    <a href={`${d.network.explorer}/tx/${h}`} target="_blank" rel="noreferrer">
      View transaction
    </a>
  );
  let body: React.ReactNode = null;
  if (tx.phase === "simulating") body = <>Checking {tx.label} against the chain…</>;
  if (tx.phase === "wallet") body = <>Confirm {tx.label} in your wallet.</>;
  if (tx.phase === "pending") body = <>Waiting for {tx.label} to be mined. {link(tx.hash)}</>;
  if (tx.phase === "done") body = <>{tx.message} {link(tx.hash)}</>;
  if (tx.phase === "failed") body = <>{tx.message} {tx.hash && link(tx.hash)}</>;
  return (
    <p className={`note ${tx.phase === "failed" ? "note-error" : tx.phase === "done" ? "note-ok" : ""}`} role="status" aria-live="polite">
      {body}
    </p>
  );
}

function useReads(d: Deployment, account?: Address) {
  const client = usePublicClient({ chainId: d.chain.id })!;
  const tokenAbi = d.token.abi as Abi;
  const vaultAbi = d.vault.abi as Abi;
  const summary = useQuery({
    queryKey: ["summary"],
    refetchInterval: 20_000,
    queryFn: async () => {
      const [totalOutstanding, giftCount, vaultBalance] = await Promise.all([
        client.readContract({ address: d.vault.address, abi: vaultAbi, functionName: "totalOutstanding" }) as Promise<bigint>,
        client.readContract({ address: d.vault.address, abi: vaultAbi, functionName: "giftCount" }) as Promise<bigint>,
        client.readContract({ address: d.token.address, abi: tokenAbi, functionName: "balanceOf", args: [d.vault.address] }) as Promise<bigint>,
      ]);
      return { totalOutstanding, giftCount, vaultBalance };
    },
  });
  const acct = useQuery({
    queryKey: ["account", account],
    enabled: !!account,
    refetchInterval: 20_000,
    queryFn: async () => {
      const a = account!;
      const [balance, points, allowance, eth] = await Promise.all([
        client.readContract({ address: d.token.address, abi: tokenAbi, functionName: "balanceOf", args: [a] }) as Promise<bigint>,
        client.readContract({ address: d.vault.address, abi: vaultAbi, functionName: "points", args: [a] }) as Promise<bigint>,
        client.readContract({ address: d.token.address, abi: tokenAbi, functionName: "allowance", args: [a, d.vault.address] }) as Promise<bigint>,
        client.getBalance({ address: a }),
      ]);
      return { balance, points, allowance, eth };
    },
  });
  return { client, summary, acct };
}

export function App({ d }: { d: Deployment }) {
  const { address, isConnected, chainId, connector } = useAccount();
  const [sheet, setSheet] = useState(false);
  const [tab, setTab] = useState<"donate" | "buy">("donate");
  const reads = useReads(d, address);
  const wrongChain = isConnected && chainId !== d.chain.id;
  const a = reads.acct.data;
  const s = reads.summary.data;

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top">
        <span className="brand">
          <img src="./favicon.svg" width={24} height={24} alt="" />
          test staking
        </span>
        <ConnectControl d={d} open={sheet} setOpen={setSheet} />
      </header>
      <main id="main" className="page">
        <section className="intro" aria-labelledby="title">
          <h1 id="title">Give testAdam. Keep the points.</h1>
          <p className="lede">Public testAdam gifts on {d.network.name}, with permanent donor points.</p>
        </section>

        <dl className="stats" aria-label="Live contract state">
          <div>
            <dt>Your balance</dt>
            <dd>{isConnected ? `${fmt(a?.balance)} testAdam` : "Connect to see"}</dd>
          </div>
          <div>
            <dt>Your points</dt>
            <dd>{isConnected ? fmt(a?.points) : "Connect to see"}</dd>
          </div>
          <div>
            <dt>Unclaimed gifts</dt>
            <dd>{s ? `${fmt(s.totalOutstanding)} testAdam` : reads.summary.isError ? "Unavailable" : "…"}</dd>
          </div>
        </dl>

        <section className="card action" aria-label="Donate or buy">
          <div className="tabs" role="tablist" aria-label="Action">
            <button role="tab" id="tab-donate" aria-selected={tab === "donate"} aria-controls="panel-donate" className="tab" onClick={() => setTab("donate")}>
              Donate
            </button>
            <button role="tab" id="tab-buy" aria-selected={tab === "buy"} aria-controls="panel-buy" className="tab" onClick={() => setTab("buy")}>
              Buy with ETH
            </button>
          </div>
          {wrongChain && connector && <WrongChain d={d} onSwitch={() => switchToChain(connector, d)} />}
          {tab === "donate" ? (
            <Donate d={d} reads={reads} wrongChain={wrongChain} openConnect={() => setSheet(true)} />
          ) : (
            <Buy d={d} reads={reads} wrongChain={wrongChain} openConnect={() => setSheet(true)} />
          )}
        </section>

        <Gifts d={d} reads={reads} wrongChain={wrongChain} openConnect={() => setSheet(true)} />
        <PoolPanel d={d} />
        <Contracts d={d} />
      </main>
      <footer className="foot">
        <p>
          Sepolia testnet. Tokens here have no real value. Source commit <span className="mono">{d.manifest.sourceCommit.slice(0, 10)}</span>.
        </p>
      </footer>
    </>
  );
}

function WrongChain({ d, onSwitch }: { d: Deployment; onSwitch: () => Promise<void> }) {
  const [err, setErr] = useState<string>();
  return (
    <div className="banner" role="alert">
      <p>Your wallet is on another network. Transactions stay off until it is on {d.network.name}.</p>
      <button className="btn btn-primary" onClick={() => onSwitch().then(() => setErr(undefined), (e) => setErr(explainError(e).text))}>
        Switch to {d.network.name}
      </button>
      {err && <p className="note note-error">{err}</p>}
    </div>
  );
}

type Reads = ReturnType<typeof useReads>;
type PanelProps = { d: Deployment; reads: Reads; wrongChain: boolean; openConnect: () => void };

function Donate({ d, reads, wrongChain, openConnect }: PanelProps) {
  const { address, isConnected } = useAccount();
  const [text, setText] = useState("");
  const amount = parseAmount(text);
  const a = reads.acct.data;
  const approveTx = useTx(d);
  const donateTx = useTx(d);
  const busy = approveTx.busy || donateTx.busy;
  const invalid = text.trim() !== "" && amount === undefined;
  const short_ = a && amount !== undefined && a.balance < amount;
  const approved = a && amount !== undefined && a.allowance >= amount;
  const ready = isConnected && !wrongChain && amount !== undefined && !short_ && !!a;
  const latest = donateTx.tx.phase !== "idle" ? donateTx.tx : approveTx.tx;

  const approve = () =>
    approveTx.run(
      "the approval",
      { address: d.token.address, abi: d.token.abi, functionName: "approve", args: [d.vault.address, amount!], account: address } as never,
      async () => {
        const allowance = (await reads.client.readContract({ address: d.token.address, abi: d.token.abi as Abi, functionName: "allowance", args: [address!, d.vault.address] })) as bigint;
        return `Approved. The vault may now take ${fmt(allowance)} testAdam from your wallet.`;
      },
    );
  const donate = () =>
    donateTx.run(
      "the donation",
      { address: d.vault.address, abi: d.vault.abi, functionName: "donate", args: [amount!], account: address } as never,
      async (r) => {
        const ev = parseEventLogs({ abi: d.vault.abi as Abi, logs: r.logs, eventName: "Donated" })[0] as unknown as
          | { args: { giftId: bigint; amount: bigint } }
          | undefined;
        const pts = (await reads.client.readContract({ address: d.vault.address, abi: d.vault.abi as Abi, functionName: "points", args: [address!] })) as bigint;
        if (!ev) return `The transaction succeeded but recorded no gift. Your points are ${fmt(pts)}.`;
        setText("");
        return `Gift #${ev.args.giftId} recorded: ${fmt(ev.args.amount)} testAdam. Your points are now ${fmt(pts)}.`;
      },
    );

  return (
    <div className="panel" role="tabpanel" id="panel-donate" aria-labelledby="tab-donate">
      <div className="field">
        <div className="field-label">
          <label htmlFor="donate-amount">Amount to give</label>
          {a && (
            <button type="button" className="link-btn" onClick={() => setText(fmtPlain(a.balance))} disabled={a.balance === 0n} aria-label={`Use full balance, ${fmt(a.balance)} testAdam`}>
              Balance {fmt(a.balance)}
            </button>
          )}
        </div>
        <span className="input-wrap">
          <input
            id="donate-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="1.5"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              approveTx.reset();
              donateTx.reset();
            }}
            aria-invalid={invalid || !!short_}
            aria-describedby="donate-help"
          />
          <span className="unit" aria-hidden="true">testAdam</span>
        </span>
      </div>
      <p id="donate-help" className={`hint ${invalid || short_ ? "hint-error" : ""}`}>
        {invalid
          ? "Use a number with at most 18 decimals, like 1.5."
          : short_
            ? `You have ${fmt(a!.balance)} testAdam. Enter that much or less.`
            : "Only Donate creates a gift and earns points: one per whole testAdam, fractions count, kept after payout."}
      </p>
      {!isConnected ? (
        <button className="btn btn-primary btn-wide" onClick={openConnect}>
          Connect a wallet to donate
        </button>
      ) : (
        <div className="steps">
          <button className="btn btn-wide btn-secondary" disabled={!ready || !!approved || busy} onClick={approve}>
            {approved ? "1. Approved" : approveTx.busy ? "1. Approving…" : "1. Approve"}
          </button>
          <button className="btn btn-wide btn-primary" disabled={!ready || !approved || busy} onClick={donate}>
            {donateTx.busy ? "2. Donating…" : "2. Donate"}
          </button>
        </div>
      )}
      <TxStatus tx={latest} d={d} />
      <details className="disclosure">
        <summary>Before you donate</summary>
        <p>
          Use Approve, then Donate. Sending testAdam directly to the vault permanently locks it, creates no gift and earns no points. Gifts made with Donate are
          public: the first wallet other than the donor address to claim receives the full gift.
        </p>
        <p>
          Points count gross donations and stay after payout. A donor can farm them by reclaiming gifts with a second wallet. Points are not proof of net giving
          and must not be used for allocations or rewards.
        </p>
      </details>
    </div>
  );
}

function fmtPlain(v: bigint) {
  return fmt(v, 18, 18).replace(/,/g, "");
}

function Buy({ d, reads, wrongChain, openConnect }: PanelProps) {
  const { address, isConnected, chainId } = useAccount();
  const [text, setText] = useState("0.01");
  const [slippage, setSlippage] = useState(100); // bps
  const [expiry, setExpiry] = useState(10); // minutes
  const [now, setNow] = useState(Date.now());
  const amount = parseAmount(text, d.network.nativeCurrency.decimals);
  const k = d.poolKey;
  const ethIn = k.currency0 === ZERO; // native ETH sorts first; buying testAdam means ETH -> token
  const zeroForOne = ethIn;
  const swapTx = useTx(d);
  const uni = d.network.uniswapV4;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const quote = useQuery({
    queryKey: ["quote", amount?.toString(), address, chainId],
    enabled: amount !== undefined,
    retry: false,
    queryFn: async () => {
      const { result } = await reads.client.simulateContract({
        address: uni.quoter,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ poolKey: k, zeroForOne, exactAmount: amount!, hookData: "0x" }],
      });
      return { out: result[0], at: Date.now() };
    },
  });
  const expired = quote.data ? now - quote.data.at > QUOTE_TTL_MS : false;
  const left = quote.data ? Math.max(0, Math.ceil((QUOTE_TTL_MS - (now - quote.data.at)) / 1000)) : 0;
  const min = quote.data ? minOut(quote.data.out, slippage) : undefined;
  const ethBal = reads.acct.data?.eth;
  const tooMuch = ethBal !== undefined && amount !== undefined && ethBal < amount;
  const invalid = text.trim() !== "" && amount === undefined;
  const quoteErr = quote.error ? explainError(quote.error) : undefined;
  const noLiquidity = quote.isError;

  const buy = () => {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + expiry * 60);
    const { commands, inputs } = encodeExactInSingle({ poolKey: k, zeroForOne, amountIn: amount!, amountOutMinimum: min!, deadline, extended: uni.extendedSwapParams === true });
    const before = reads.acct.data?.balance ?? 0n;
    swapTx.run(
      "the buy",
      { address: uni.universalRouter, abi: universalRouterAbi, functionName: "execute", args: [commands, inputs, deadline], value: amount!, account: address } as never,
      async (r) => {
        const logs = parseEventLogs({ abi: d.token.abi as Abi, logs: r.logs, eventName: "Transfer" }) as unknown as { address: string; args: { to: string; value: bigint } }[];
        const got = logs
          .filter((l) => l.address.toLowerCase() === d.token.address.toLowerCase() && l.args.to.toLowerCase() === address!.toLowerCase())
          .reduce((x, l) => x + l.args.value, 0n);
        const after = (await reads.client.readContract({ address: d.token.address, abi: d.token.abi as Abi, functionName: "balanceOf", args: [address!], blockNumber: r.blockNumber })) as bigint;
        return `Bought ${fmt(got)} testAdam for ${fmt(amount!)} ETH in block ${r.blockNumber}. Balance ${fmt(before)} → ${fmt(after)} testAdam.`;
      },
    );
  };

  let action: React.ReactNode;
  if (!isConnected)
    action = (
      <button className="btn btn-primary btn-wide" onClick={openConnect}>
        Connect a wallet to buy
      </button>
    );
  else if (expired)
    action = (
      <button className="btn btn-secondary btn-wide" onClick={() => quote.refetch()} disabled={quote.isFetching}>
        Quote expired. Refresh quote
      </button>
    );
  else
    action = (
      <button
        className="btn btn-primary btn-wide"
        disabled={wrongChain || !quote.data || quote.isFetching || tooMuch || swapTx.busy || !min || min === 0n}
        onClick={buy}
      >
        {swapTx.busy ? "Buying…" : "Buy testAdam"}
      </button>
    );

  return (
    <div className="panel" role="tabpanel" id="panel-buy" aria-labelledby="tab-buy">
      <div className="field">
        <div className="field-label">
          <label htmlFor="buy-amount">ETH to spend</label>
          {ethBal !== undefined && <span className="muted">Balance {fmt(ethBal)} ETH</span>}
        </div>
        <span className="input-wrap">
          <input
            id="buy-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.01"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              swapTx.reset();
            }}
            aria-invalid={invalid || tooMuch}
            aria-describedby="buy-quote"
          />
          <span className="unit" aria-hidden="true">ETH</span>
        </span>
      </div>
      <div className="row-2">
        <label className="field">
          <span className="field-label">Slippage</span>
          <select value={slippage} onChange={(e) => setSlippage(Number(e.target.value))}>
            <option value={50}>0.5%</option>
            <option value={100}>1%</option>
            <option value={200}>2%</option>
            <option value={500}>5%</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Expires after</span>
          <select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
            <option value={5}>5 min</option>
            <option value={10}>10 min</option>
            <option value={20}>20 min</option>
          </select>
        </label>
      </div>
      <div id="buy-quote" className="quote" aria-live="polite">
        {invalid ? (
          <p className="hint hint-error">Use a number with at most 18 decimals, like 0.01.</p>
        ) : amount === undefined ? (
          <p className="hint">Enter how much ETH to spend.</p>
        ) : quote.isFetching && !quote.data ? (
          <p className="hint">Getting a quote from the Uniswap v4 quoter…</p>
        ) : noLiquidity ? (
          <p className="hint hint-error">
            No quote: {quoteErr?.text}. The pool may not have enough liquidity for this amount. Try a smaller amount.
          </p>
        ) : quote.data && min !== undefined ? (
          <dl className="kv">
            <div>
              <dt>You receive about</dt>
              <dd>{fmt(quote.data.out)} testAdam</dd>
            </div>
            <div>
              <dt>Minimum received</dt>
              <dd>
                {fmt(min)} testAdam <span className="muted">at {slippage / 100}% slippage</span>
              </dd>
            </div>
            <div>
              <dt>Rate</dt>
              <dd>1 ETH ≈ {fmt((quote.data.out * 10n ** 18n) / amount, 18, 2)} testAdam</dd>
            </div>
            <div>
              <dt>Quote</dt>
              <dd>{expired ? "Expired" : quote.isFetching ? "Refreshing…" : `Valid for ${left}s`}</dd>
            </div>
            <div>
              <dt>Deadline</dt>
              <dd>Reverts if not mined {expiry} min after you sign</dd>
            </div>
          </dl>
        ) : null}
        {tooMuch && <p className="hint hint-error">You have {fmt(ethBal)} ETH. Enter less, leaving some for gas.</p>}
      </div>
      {action}
      <TxStatus tx={swapTx.tx} d={d} />
      <p className="hint">
        Swaps the native ETH/testAdam pool ({k.fee / 10_000}% fee) through the Uniswap v4 Universal Router. The page checks the swap against the chain before your
        wallet opens.
      </p>
    </div>
  );
}

const PAGE = 10;
type Gift = { id: bigint; donor: Address; amount: bigint; claimed: boolean };

function Gifts({ d, reads, wrongChain, openConnect }: PanelProps) {
  const { address, isConnected } = useAccount();
  const [pages, setPages] = useState(1);
  const [openOnly, setOpenOnly] = useState(false);
  const count = reads.summary.data?.giftCount;
  const gifts = useQuery({
    queryKey: ["gifts", count?.toString(), pages],
    enabled: count !== undefined,
    queryFn: async (): Promise<Gift[]> => {
      const n = Number(count!);
      const ids: bigint[] = [];
      for (let i = n; i >= 1 && ids.length < pages * PAGE; i--) ids.push(BigInt(i));
      return Promise.all(
        ids.map(async (id) => {
          const [donor, amount, claimed] = (await reads.client.readContract({ address: d.vault.address, abi: d.vault.abi as Abi, functionName: "getGift", args: [id] })) as [Address, bigint, boolean];
          return { id, donor, amount, claimed };
        }),
      );
    },
  });
  const list = useMemo(() => (gifts.data ?? []).filter((g) => !openOnly || !g.claimed), [gifts.data, openOnly]);
  const openCount = (gifts.data ?? []).filter((g) => !g.claimed).length;

  return (
    <section className="card" aria-labelledby="gifts-title">
      <div className="section-head">
        <h2 id="gifts-title">Gifts</h2>
        <label className="check">
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
          Open only
        </label>
      </div>
      <p className="hint">The first wallet other than the donor to claim gets the full gift.</p>
      {count !== undefined && count > 0n && gifts.data && (
        <p className="hint tabular">
          {count.toString()} total · {openCount} open of {gifts.data.length} shown
        </p>
      )}
      {reads.summary.isError ? (
        <p className="note note-error">Gifts could not be read from the vault. Check your connection; the page retries every 20 seconds.</p>
      ) : count === 0n ? (
        <p className="empty">No gifts yet. Donate above to create the first one.</p>
      ) : gifts.isLoading || count === undefined ? (
        <p className="hint">Loading gifts…</p>
      ) : (
        <ul className="gifts">
          {list.map((g) => (
            <GiftRow key={g.id.toString()} g={g} d={d} me={address} canSend={isConnected && !wrongChain} openConnect={openConnect} isConnected={isConnected} reads={reads} />
          ))}
          {list.length === 0 && <li className="empty">No open gifts among those shown.</li>}
        </ul>
      )}
      {count !== undefined && gifts.data && BigInt(gifts.data.length) < count && (
        <button className="btn btn-secondary" onClick={() => setPages(pages + 1)}>
          Show {PAGE} older gifts
        </button>
      )}
    </section>
  );
}

function GiftRow({ g, d, me, canSend, isConnected, openConnect, reads }: { g: Gift; d: Deployment; me?: Address; canSend: boolean; isConnected: boolean; openConnect: () => void; reads: Reads }) {
  const claimTx = useTx(d);
  const mine = !!me && me.toLowerCase() === g.donor.toLowerCase();
  const claim = () =>
    claimTx.run("the claim", { address: d.vault.address, abi: d.vault.abi, functionName: "claim", args: [g.id], account: me } as never, async (r) => {
      const ev = parseEventLogs({ abi: d.vault.abi as Abi, logs: r.logs, eventName: "Claimed" })[0] as unknown as { args: { amount: bigint } } | undefined;
      const bal = (await reads.client.readContract({ address: d.token.address, abi: d.token.abi as Abi, functionName: "balanceOf", args: [me!], blockNumber: r.blockNumber })) as bigint;
      return ev ? `You received ${fmt(ev.args.amount)} testAdam from gift #${g.id}. Balance now ${fmt(bal)}.` : `The claim succeeded but emitted no payout. Balance ${fmt(bal)}.`;
    });
  return (
    <li className="gift">
      <div className="gift-main">
        <span className="gift-id">#{g.id.toString()}</span>
        <span className="gift-amt">{fmt(g.amount)} testAdam</span>
        <span className="muted">
          from{" "}
          <a className="mono" href={`${d.network.explorer}/address/${g.donor}`} target="_blank" rel="noreferrer">
            {mine ? "you" : short(g.donor)}
          </a>
        </span>
      </div>
      <div className="gift-side">
        {g.claimed ? (
          <span className="status status-done">Claimed</span>
        ) : mine ? (
          <span className="status">Open · your gift</span>
        ) : !isConnected ? (
          <button className="btn btn-secondary btn-sm" onClick={openConnect}>
            Connect to claim
          </button>
        ) : (
          <button className="btn btn-primary btn-sm" disabled={!canSend || claimTx.busy} onClick={claim}>
            {claimTx.busy ? "Claiming…" : `Claim #${g.id}`}
          </button>
        )}
      </div>
      {claimTx.tx.phase !== "idle" && <TxStatus tx={claimTx.tx} d={d} />}
    </li>
  );
}

function PoolPanel({ d }: { d: Deployment }) {
  const client = usePublicClient({ chainId: d.chain.id })!;
  const pool = useQuery({ queryKey: ["pool"], queryFn: () => loadPool(client, d), refetchInterval: 120_000, retry: 1 });
  const p = pool.data;
  return (
    <section className="card" aria-labelledby="pool-title">
      <h2 id="pool-title">Pool</h2>
      <p className="hint">
        ETH/testAdam on Uniswap v4 at one finalized block. Values in ETH; no USD source.
      </p>
      {pool.isError ? (
        <p className="note note-error">Pool data did not load: {explainError(pool.error).text}. It retries every two minutes.</p>
      ) : !p ? (
        <p className="hint">Reading the finalized block and scanning 24 hours of swaps…</p>
      ) : (
        <dl className="kv">
          <div>
            <dt>Finalized block</dt>
            <dd>
              <a href={`${d.network.explorer}/block/${p.block}`} target="_blank" rel="noreferrer">
                #{p.block.toString()}
              </a>{" "}
              <span className="muted">{utc(p.timestamp)}</span>
            </dd>
          </div>
          <div>
            <dt>Price</dt>
            <dd>{p.sqrtPriceX96 === 0n ? "Not initialized at this block" : `${fmt(p.ethPerToken, 18, 12)} ETH per testAdam`}</dd>
          </div>
          <div>
            <dt>Active liquidity</dt>
            <dd>{p.liquidity === 0n ? <strong className="warn">Zero active liquidity at this block</strong> : p.liquidity.toString()}</dd>
          </div>
          <div>
            <dt>Fully diluted value</dt>
            <dd>{p.sqrtPriceX96 === 0n ? "Unavailable without a price" : `${fmt(p.fdvWei, 18, 4)} ETH`} <span className="muted">from totalSupply {fmt(p.totalSupply, 18, 0)}</span></dd>
          </div>
          <div>
            <dt>Circulating market cap</dt>
            <dd>
              Unavailable. <span className="muted">Supply basis unknown: the deployment handoff documents no locked or unreleased holders, so circulating supply cannot be verified.</span>
            </dd>
          </div>
          <div>
            <dt>24h volume</dt>
            <dd>
              {p.volume.status === "complete" ? (
                <>
                  {fmt(p.volume.wei, 18, 6)} ETH <span className="muted">({p.volume.swaps} swaps, ETH leg)</span>
                </>
              ) : (
                <>Unavailable: partial scan.</>
              )}
            </dd>
          </div>
          <div>
            <dt>Coverage</dt>
            <dd className="muted">
              {p.volume.status === "complete"
                ? p.volume.note ?? `Blocks ${p.volume.fromBlock}–${p.volume.toBlock}, ${utc(p.volume.fromTime)} to ${utc(p.timestamp)}${p.initBlock && p.volume.fromBlock === p.initBlock ? ", starting at pool initialization" : ""}.`
                : p.volume.reason}
            </dd>
          </div>
          <div>
            <dt>Pool id</dt>
            <dd className="mono wrap">{p.poolId}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}

function Contracts({ d }: { d: Deployment }) {
  const ex = (a: string) => `${d.network.explorer}/address/${a}`;
  const k = d.poolKey;
  const u = d.network.uniswapV4;
  const rows: [string, string][] = [
    ["LaunchToken (testAdam)", d.token.address],
    ["DonationVault", d.vault.address],
    ["Uniswap v4 PoolManager", u.poolManager],
    ["Universal Router", u.universalRouter],
    ["Quoter", u.quoter],
    ["StateView", u.stateView],
  ];
  return (
    <section className="card" aria-labelledby="contracts-title">
      <h2 id="contracts-title">Contracts</h2>
      <p className="hint">
        {d.network.name}, chain {d.chain.id}. Every address below comes from this site's imd-deployment.json.
      </p>
      <dl className="kv">
        {rows.map(([n, a]) => (
          <div key={n}>
            <dt>{n}</dt>
            <dd>
              <a className="mono wrap" href={ex(a)} target="_blank" rel="noreferrer">
                {a}
              </a>
            </dd>
          </div>
        ))}
        <div>
          <dt>Pool key</dt>
          <dd className="mono wrap">
            {k.currency0} / {k.currency1} · fee {k.fee} · tick spacing {k.tickSpacing} · hooks {k.hooks}
          </dd>
        </div>
        <div>
          <dt>Attestation</dt>
          <dd className="mono wrap">{d.manifest.attestationHash}</dd>
        </div>
      </dl>
    </section>
  );
}
