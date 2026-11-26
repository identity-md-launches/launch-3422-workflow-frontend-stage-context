import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useAccount, useConfig, usePublicClient } from "wagmi";
import { getPublicClient, simulateContract, writeContract } from "wagmi/actions";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseEventLogs, type Abi, type Address, type Hex, type TransactionReceipt } from "viem";
import type { Deployment } from "./deployment";
import { ConnectControl, explainError, isLiquidityError, switchToChain } from "./wallet";
import { example, fmt, fmtInput, parseAmount, short, utc } from "./format";
import { encodeExactInSingle, minOut, quoterAbi, universalRouterAbi } from "./uniswap";
import { loadPool } from "./pool";

const ZERO = "0x0000000000000000000000000000000000000000";
const QUOTE_TTL_MS = 30_000;
const BALANCE_UNAVAILABLE = "Balance unavailable. Refresh to try again.";

type Tx =
  | { phase: "idle" }
  | { phase: "simulating" | "wallet"; label: string }
  | { phase: "pending"; label: string; hash: Hex }
  | { phase: "done"; hash: Hex; message: string }
  | { phase: "failed"; message: string; hash?: Hex };

/** What a confirmed receipt shows right away, plus an optional follow-up read that may fail on its own. */
type Outcome = { message: string; detail?: () => Promise<string>; detailFailed?: string };
type RunOpts = {
  /** Checked after the simulation and before the wallet opens. A returned message stops the request. */
  guard?: () => string | undefined;
  /** After a failed simulation or a mined revert: reread state and return a message that replaces the generic one. */
  afterFail?: (errorName: string | undefined, mined: boolean) => Promise<string | undefined>;
};

/** Simulate, send, wait for the receipt, and report what the receipt shows. Never reports the simulation's result. */
function useTx(d: Deployment) {
  const config = useConfig();
  const qc = useQueryClient();
  const [tx, setTx] = useState<Tx>({ phase: "idle" });
  const busy = tx.phase === "simulating" || tx.phase === "wallet" || tx.phase === "pending";
  const refresh = () => void qc.invalidateQueries().catch(() => undefined);
  async function override(opts: RunOpts | undefined, name: string | undefined, mined: boolean) {
    try {
      return await opts?.afterFail?.(name, mined);
    } catch {
      return undefined;
    }
  }
  async function run(label: string, params: Parameters<typeof simulateContract>[1], describe: (r: TransactionReceipt) => Outcome, opts?: RunOpts) {
    let hash: Hex | undefined;
    try {
      setTx({ phase: "simulating", label });
      const { request } = await simulateContract(config, { ...params, chainId: d.chain.id } as never);
      const stop = opts?.guard?.();
      if (stop) {
        setTx({ phase: "failed", message: stop });
        return;
      }
      setTx({ phase: "wallet", label });
      hash = await writeContract(config, request as never);
      setTx({ phase: "pending", label, hash });
      // viem's own wait returns a reverted receipt instead of throwing, so a revert is reported from the receipt.
      const receipt = await getPublicClient(config, { chainId: d.chain.id })!.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        refresh();
        const msg = (await override(opts, undefined, true)) ?? `The transaction reverted in block ${receipt.blockNumber}. Nothing changed.`;
        setTx({ phase: "failed", hash, message: msg });
        return;
      }
      let out: Outcome;
      try {
        out = describe(receipt);
      } catch {
        out = { message: `Confirmed in block ${receipt.blockNumber}.` };
      }
      const h = hash;
      setTx({ phase: "done", hash: h, message: out.message });
      refresh();
      if (out.detail) {
        let more: string;
        try {
          more = await out.detail();
        } catch {
          more = out.detailFailed ?? BALANCE_UNAVAILABLE;
        }
        setTx((t) => (t.phase === "done" && t.hash === h ? { ...t, message: `${out.message} ${more}` } : t));
      }
    } catch (e) {
      const ex = explainError(e);
      if (hash || ex.name === "AlreadyClaimed" || ex.name === "UnknownGift") refresh();
      const msg = (await override(opts, ex.name, false)) ?? ex.text;
      setTx({ phase: "failed", hash, message: msg });
    }
  }
  return {
    tx,
    busy,
    run,
    /** Clears finished feedback only. A request in flight keeps its status, link and busy flag. */
    resetTerminal: () => setTx((t) => (t.phase === "done" || t.phase === "failed" ? { phase: "idle" } : t)),
  };
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

const TABS = [
  ["donate", "Donate"],
  ["buy", "Buy with ETH"],
] as const;
type TabId = (typeof TABS)[number][0];

export function App({ d }: { d: Deployment }) {
  const { address, isConnected, chainId, connector } = useAccount();
  const [sheet, setSheet] = useState(false);
  const [tab, setTab] = useState<TabId>("donate");
  const reads = useReads(d, address);
  const wrongChain = isConnected && chainId !== d.chain.id;
  const a = reads.acct.data;
  const s = reads.summary.data;
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const i = TABS.findIndex(([id]) => id === tab);
    const n = e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : (i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
    const next = TABS[n][0];
    setTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

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
          <div className="tabs" role="tablist" aria-label="Action" onKeyDown={onTabKey}>
            {TABS.map(([id, name]) => (
              <button
                key={id}
                role="tab"
                id={`tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                className="tab"
                onClick={() => setTab(id)}
              >
                {name}
              </button>
            ))}
          </div>
          {wrongChain && connector && <WrongChain d={d} onSwitch={() => switchToChain(connector, d)} />}
          {/* Both panels stay mounted so a pending transaction keeps its status and busy state across tab switches. */}
          <Donate d={d} reads={reads} wrongChain={wrongChain} openConnect={() => setSheet(true)} active={tab === "donate"} />
          <Buy d={d} reads={reads} wrongChain={wrongChain} openConnect={() => setSheet(true)} active={tab === "buy"} />
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
type PanelProps = { d: Deployment; reads: Reads; wrongChain: boolean; openConnect: () => void; active?: boolean };

function Donate({ d, reads, wrongChain, openConnect, active = true }: PanelProps) {
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

  const approve = () => {
    const owner = address!;
    approveTx.run(
      "the approval",
      { address: d.token.address, abi: d.token.abi, functionName: "approve", args: [d.vault.address, amount!], account: owner } as never,
      (r) => {
        const ev = (parseEventLogs({ abi: d.token.abi as Abi, logs: r.logs, eventName: "Approval" }) as unknown as { address: string; args: { owner: string; value: bigint } }[]).find(
          (l) => l.address.toLowerCase() === d.token.address.toLowerCase() && l.args.owner.toLowerCase() === owner.toLowerCase(),
        );
        return {
          message: ev ? `Approved ${fmt(ev.args.value)} testAdam for the vault in block ${r.blockNumber}.` : `Confirmed in block ${r.blockNumber}, but it logged no approval.`,
          detail: async () => {
            const allowance = (await reads.client.readContract({ address: d.token.address, abi: d.token.abi as Abi, functionName: "allowance", args: [owner, d.vault.address] })) as bigint;
            return `The vault may now take ${fmt(allowance)} testAdam from your wallet.`;
          },
          detailFailed: "Allowance unavailable. Refresh to try again.",
        };
      },
    );
  };
  const donate = () => {
    const donor = address!;
    donateTx.run(
      "the donation",
      { address: d.vault.address, abi: d.vault.abi, functionName: "donate", args: [amount!], account: donor } as never,
      (r) => {
        const ev = parseEventLogs({ abi: d.vault.abi as Abi, logs: r.logs, eventName: "Donated" })[0] as unknown as { args: { giftId: bigint; amount: bigint } } | undefined;
        if (ev) setText("");
        return {
          message: ev ? `Gift #${ev.args.giftId} recorded: ${fmt(ev.args.amount)} testAdam.` : `Confirmed in block ${r.blockNumber}, but it recorded no gift.`,
          detail: async () => {
            const pts = (await reads.client.readContract({ address: d.vault.address, abi: d.vault.abi as Abi, functionName: "points", args: [donor], blockNumber: r.blockNumber })) as bigint;
            return `Your points are now ${fmt(pts)}.`;
          },
          detailFailed: "Points unavailable. Refresh to try again.",
        };
      },
    );
  };

  return (
    <div className="panel" role="tabpanel" id="panel-donate" aria-labelledby="tab-donate" hidden={!active}>
      <div className="field">
        <div className="field-label">
          <label htmlFor="donate-amount">Amount to give</label>
          {a && (
            <button type="button" className="link-btn" onClick={() => setText(fmtInput(a.balance))} disabled={a.balance === 0n} aria-label={`Use full balance, ${fmt(a.balance)} testAdam`}>
              Balance {fmt(a.balance)}
            </button>
          )}
        </div>
        <span className="input-wrap">
          <input
            id="donate-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder={example("1.5")}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              approveTx.resetTerminal();
              donateTx.resetTerminal();
            }}
            aria-invalid={invalid || !!short_}
            aria-describedby="donate-help"
          />
          <span className="unit" aria-hidden="true">testAdam</span>
        </span>
      </div>
      <p id="donate-help" className={`hint ${invalid || short_ ? "hint-error" : ""}`}>
        {invalid
          ? `Enter a positive amount with at most 18 decimals, like ${example("1.5")}.`
          : short_
            ? `You have ${fmt(a!.balance)} testAdam. Enter that much or less.`
            : "Only Donate creates a gift. You earn one nontransferable point per testAdam the vault receives, including fractions, and keep those points after payout."}
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
          Points cannot be transferred. They count gross donations and stay after payout. A donor can farm them by reclaiming gifts with a second wallet. Points are not proof of net giving
          and must not be used for allocations or rewards.
        </p>
      </details>
    </div>
  );
}

function Buy({ d, reads, wrongChain, openConnect, active = true }: PanelProps) {
  const { address, isConnected, chainId } = useAccount();
  const [text, setText] = useState(() => example("0.01"));
  const [slippage, setSlippage] = useState(100); // bps
  const [expiry, setExpiry] = useState(10); // minutes
  const [deadline, setDeadline] = useState<bigint>();
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
    enabled: active && amount !== undefined,
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
  const positive = !!quote.data && quote.data.out > 0n && !quote.isError;
  const expired = positive ? now - quote.data!.at > QUOTE_TTL_MS : false;
  const left = positive ? Math.max(0, Math.ceil((QUOTE_TTL_MS - (now - quote.data!.at)) / 1000)) : 0;
  const min = positive ? minOut(quote.data!.out, slippage) : undefined;
  const ethBal = reads.acct.data?.eth;
  const tooMuch = ethBal !== undefined && amount !== undefined && ethBal < amount;
  const invalid = text.trim() !== "" && amount === undefined;
  const quoteErr = quote.isError ? explainError(quote.error) : undefined;
  const noLiquidity = quote.isError && isLiquidityError(quote.error);

  const buy = () => {
    const quotedAt = quote.data!.at;
    if (Date.now() - quotedAt > QUOTE_TTL_MS) return;
    const amt = amount!;
    const buyer = address!;
    const dl = BigInt(Math.floor(Date.now() / 1000) + expiry * 60);
    setDeadline(dl);
    const { commands, inputs } = encodeExactInSingle({ poolKey: k, zeroForOne, amountIn: amt, amountOutMinimum: min!, deadline: dl, extended: uni.extendedSwapParams === true });
    const before = reads.acct.data?.balance;
    swapTx.run(
      "the buy",
      { address: uni.universalRouter, abi: universalRouterAbi, functionName: "execute", args: [commands, inputs, dl], value: amt, account: buyer } as never,
      (r) => {
        const logs = parseEventLogs({ abi: d.token.abi as Abi, logs: r.logs, eventName: "Transfer" }) as unknown as { address: string; args: { to: string; value: bigint } }[];
        const got = logs
          .filter((l) => l.address.toLowerCase() === d.token.address.toLowerCase() && l.args.to.toLowerCase() === buyer.toLowerCase())
          .reduce((x, l) => x + l.args.value, 0n);
        return {
          message:
            got > 0n
              ? `Bought ${fmt(got)} testAdam for ${fmt(amt)} ETH in block ${r.blockNumber}.`
              : `Confirmed in block ${r.blockNumber}, but no testAdam reached your wallet.`,
          detail: async () => {
            const after = (await reads.client.readContract({ address: d.token.address, abi: d.token.abi as Abi, functionName: "balanceOf", args: [buyer], blockNumber: r.blockNumber })) as bigint;
            return before !== undefined ? `Balance ${fmt(before)} → ${fmt(after)} testAdam.` : `Balance ${fmt(after)} testAdam.`;
          },
        };
      },
      {
        // The simulation can take long enough for the quote to expire; hold the wallet request if it did.
        guard: () => (Date.now() - quotedAt > QUOTE_TTL_MS ? "Quote expired. Refresh quote, then choose Buy again. Nothing was sent." : undefined),
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
  else if (swapTx.busy)
    action = (
      <button className="btn btn-primary btn-wide" disabled>
        Buying…
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
      <button className="btn btn-primary btn-wide" disabled={wrongChain || !positive || quote.isFetching || tooMuch || !min || min === 0n} onClick={buy}>
        Buy testAdam
      </button>
    );

  return (
    <div className="panel" role="tabpanel" id="panel-buy" aria-labelledby="tab-buy" hidden={!active}>
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
            placeholder={example("0.01")}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              swapTx.resetTerminal();
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
          <span className="field-label">Transaction deadline</span>
          <select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
            <option value={5}>5 min</option>
            <option value={10}>10 min</option>
            <option value={20}>20 min</option>
          </select>
        </label>
      </div>
      <div id="buy-quote" className="quote" aria-live="polite">
        {invalid ? (
          <p className="hint hint-error">Enter a positive amount with at most 18 decimals, like {example("0.01")}.</p>
        ) : amount === undefined ? (
          <p className="hint">Enter how much ETH to spend.</p>
        ) : quote.isFetching && !quote.data && !quote.isError ? (
          <p className="hint">Getting a quote from the Uniswap v4 quoter…</p>
        ) : noLiquidity ? (
          <p className="hint hint-error">Insufficient liquidity for this amount. Enter less.</p>
        ) : quote.isError ? (
          <div className="retry">
            <p className="hint hint-error">Quote unavailable: {quoteErr?.text}</p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => quote.refetch()} disabled={quote.isFetching}>
              {quote.isFetching ? "Retrying…" : "Retry quote"}
            </button>
          </div>
        ) : quote.data && quote.data.out === 0n ? (
          <p className="hint hint-error">This amount buys 0 testAdam. Enter a larger amount.</p>
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
              <dd>
                Deadline starts when you click Buy.
                {deadline !== undefined && <span className="muted"> Last buy: reverts if not mined by {utc(deadline)}.</span>}
              </dd>
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
    // Same cycle as the summary: another wallet's claim leaves giftCount unchanged, so rows are reread on their own.
    refetchInterval: 20_000,
    placeholderData: keepPreviousData,
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
      ) : gifts.isError && !gifts.data ? (
        <div className="retry">
          <p className="note note-error">Gift details couldn&rsquo;t be loaded.</p>
          <button className="btn btn-secondary btn-sm" onClick={() => gifts.refetch()} disabled={gifts.isFetching}>
            {gifts.isFetching ? "Retrying…" : "Retry gifts"}
          </button>
        </div>
      ) : gifts.isLoading || count === undefined || !gifts.data ? (
        <p className="hint">Loading gifts…</p>
      ) : (
        <>
          {gifts.isError && (
            <div className="retry">
              <p className="note note-error">
                Gift details didn&rsquo;t refresh. Claim status last checked at {new Date(gifts.dataUpdatedAt).toISOString().slice(11, 19)} UTC.
              </p>
              <button className="btn btn-secondary btn-sm" onClick={() => gifts.refetch()} disabled={gifts.isFetching}>
                {gifts.isFetching ? "Retrying…" : "Retry gifts"}
              </button>
            </div>
          )}
          <ul className="gifts">
            {list.map((g) => (
              <GiftRow key={g.id.toString()} g={g} d={d} me={address} canSend={isConnected && !wrongChain} openConnect={openConnect} isConnected={isConnected} reads={reads} />
            ))}
            {list.length === 0 && <li className="empty">No open gifts among those shown.</li>}
          </ul>
        </>
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
  const claim = () => {
    const claimer = me!;
    claimTx.run(
      "the claim",
      { address: d.vault.address, abi: d.vault.abi, functionName: "claim", args: [g.id], account: claimer } as never,
      (r) => {
        const ev = parseEventLogs({ abi: d.vault.abi as Abi, logs: r.logs, eventName: "Claimed" })[0] as unknown as { args: { amount: bigint } } | undefined;
        return {
          message: ev ? `You received ${fmt(ev.args.amount)} testAdam from gift #${g.id}.` : `Confirmed in block ${r.blockNumber}, but it paid out nothing.`,
          detail: async () => {
            const bal = (await reads.client.readContract({ address: d.token.address, abi: d.token.abi as Abi, functionName: "balanceOf", args: [claimer], blockNumber: r.blockNumber })) as bigint;
            return `Balance now ${fmt(bal)} testAdam.`;
          },
        };
      },
      {
        // A failed preflight or a mined revert: reread this gift. If it is claimed now, another wallet won it.
        afterFail: async () => {
          const [, , claimed] = (await reads.client.readContract({ address: d.vault.address, abi: d.vault.abi as Abi, functionName: "getGift", args: [g.id] })) as [Address, bigint, boolean];
          return claimed ? "Another wallet claimed this gift first." : undefined;
        },
      },
    );
  };
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
            <dd>
              {p.totalSupply === undefined ? (
                <>
                  Unavailable. <span className="muted">The token has no code at this block, so it has no supply yet.</span>
                </>
              ) : p.sqrtPriceX96 === 0n ? (
                <>
                  Unavailable without a price <span className="muted">(totalSupply {fmt(p.totalSupply, 18, 0)})</span>
                </>
              ) : (
                <>
                  {fmt(p.fdvWei, 18, 4)} ETH <span className="muted">from totalSupply {fmt(p.totalSupply, 18, 0)}</span>
                </>
              )}
            </dd>
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
                <>{p.volume.headline ?? "Unavailable: partial scan."}</>
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
