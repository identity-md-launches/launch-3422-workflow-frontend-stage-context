// Wallet wiring per the network's wallet-connectors reference: EIP-6963 browser wallets, "Open in"
// links for phones, Coinbase Smart Wallet. No relay and no project id.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { createConfig, fallback, http, useAccount, useConnect, useDisconnect, type Connector } from "wagmi";
import { coinbaseWallet, injected } from "wagmi/connectors";
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, toFunctionSelector, toHex } from "viem";
import { SITE, type Deployment } from "./deployment";
import { WALLET_ICONS } from "./wallet-icons";
import { short } from "./format";

export function makeWagmiConfig(d: Deployment) {
  return createConfig({
    chains: [d.chain],
    multiInjectedProviderDiscovery: true,
    connectors: [injected(), coinbaseWallet({ appName: SITE.name, preference: { options: "all", telemetry: false } })],
    transports: { [d.chain.id]: fallback(d.network.rpcUrls.map((u) => http(u, { batch: true }))) },
  });
}

/** Open this page inside a wallet's own browser (vendor-documented links, no relay). */
export const OPEN_IN: ReadonlyArray<{ id: string; name: string; href: (url: string) => string }> = [
  { id: "metamask", name: "MetaMask", href: (url) => `https://link.metamask.io/dapp/${url.replace(/^https?:\/\//, "")}` },
  { id: "coinbase", name: "Coinbase Wallet", href: (url) => `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url)}` },
  { id: "phantom", name: "Phantom", href: (url) => `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(new URL(url).origin)}` },
];
export const isPhone = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const hasLegacyProvider = () => !!(window as unknown as { ethereum?: unknown }).ethereum;

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

/** wallet_switchEthereumChain, then wallet_addEthereumChain with the manifest's parameters when the wallet lacks the chain. */
export async function switchToChain(connector: Connector, d: Deployment) {
  const provider = (await connector.getProvider()) as Eip1193;
  const chainId = toHex(d.chain.id);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (e) {
    const err = e as { code?: number; message?: string; data?: { originalError?: { code?: number } } };
    const code = err.code ?? err.data?.originalError?.code;
    if (code === 4902 || /unrecognized|unknown chain|not been added|not added/i.test(err.message ?? "")) {
      const params = d.walletAddChain ?? {
        chainId,
        chainName: d.network.name,
        rpcUrls: d.network.rpcUrls,
        nativeCurrency: d.network.nativeCurrency,
        blockExplorerUrls: [d.network.explorer],
      };
      await provider.request({ method: "wallet_addEthereumChain", params: [params] });
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    } else throw e;
  }
}

const ERRORS: Record<string, string> = {
  ZeroAmount: "Enter an amount greater than zero.",
  NothingReceived: "The vault received nothing, so no gift was recorded.",
  UnknownGift: "That gift does not exist. The list has been refreshed.",
  AlreadyClaimed: "Another wallet claimed this gift first. The list has been refreshed.",
  SelfClaim: "You donated this gift, so this address cannot claim it.",
  TransferFailed: "The token transfer failed. Check your testAdam balance and approval, then try again.",
  Reentrancy: "The vault rejected a nested call.",
  ERC20InsufficientBalance: "Your testAdam balance is lower than this amount.",
  ERC20InsufficientAllowance: "The approval is lower than this amount. Approve again.",
  V4TooLittleReceived: "The price moved past your slippage limit. Refresh the quote or raise slippage.",
  TransactionDeadlinePassed: "The swap deadline passed. Refresh the quote and try again.",
};

const NOT_ENOUGH_LIQUIDITY = toFunctionSelector("NotEnoughLiquidity(bytes32)");

/** True only when the Quoter itself says the pool cannot fill the amount; provider failures are not liquidity. */
export function isLiquidityError(e: unknown): boolean {
  if (!(e instanceof BaseError)) return false;
  const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (!rev) return false;
  const name = rev.data?.errorName;
  if (name === "NotEnoughLiquidity") return true;
  const raw = (rev as unknown as { raw?: string }).raw ?? "";
  const inner = name === "UnexpectedRevertBytes" ? String(rev.data?.args?.[0] ?? "") : "";
  return raw.startsWith(NOT_ENOUGH_LIQUIDITY) || inner.startsWith(NOT_ENOUGH_LIQUIDITY);
}

/** One plain sentence for a failed simulation, wallet request or transaction. */
export function explainError(e: unknown): { text: string; name?: string } {
  if (e instanceof BaseError) {
    const rej = e.walk((x) => x instanceof UserRejectedRequestError);
    if (rej) return { text: "You declined the request in your wallet. Nothing was sent.", name: "UserRejected" };
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (rev) {
      const name = rev.data?.errorName;
      if (name && ERRORS[name]) return { text: ERRORS[name], name };
      if (name) return { text: `The contract would revert with ${name}.`, name };
      if (rev.reason) return { text: `The contract would revert: ${rev.reason}.` };
    }
    return { text: e.shortMessage || e.message };
  }
  const any = e as { code?: number; message?: string };
  if (any?.code === 4001) return { text: "You declined the request in your wallet. Nothing was sent.", name: "UserRejected" };
  return { text: any?.message ?? String(e) };
}

const FOCUSABLE = 'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"])';

export function ConnectControl({ d, open, setOpen }: { d: Deployment; open: boolean; setOpen: (v: boolean) => void }) {
  const phone = isPhone();
  const legacy = hasLegacyProvider();
  const { address, isConnected, chainId, connector } = useAccount();
  const { connectors, connect, isPending, variables, error, reset } = useConnect();
  const { disconnect } = useDisconnect();
  const [menu, setMenu] = useState(false);
  const [switchErr, setSwitchErr] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open && !menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (open) setOpen(false); // focus goes back to the opener when the sheet unmounts
      if (menu) {
        setMenu(false);
        trigger.current?.focus();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open, menu, setOpen]);
  useEffect(() => {
    if (isConnected) setOpen(false);
  }, [isConnected, setOpen]);
  // Modal: the page behind is inert while the sheet is open, and focus returns to whatever opened it.
  useLayoutEffect(() => {
    if (!open) {
      reset();
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    opener.current = active && active !== document.body ? active : trigger.current;
    const root = document.getElementById("root");
    root?.setAttribute("inert", "");
    (sheet.current?.querySelector(".sheet-rows a, .sheet-rows button") as HTMLElement | null)?.focus();
    return () => {
      root?.removeAttribute("inert");
      const o = opener.current;
      if (o?.isConnected) o.focus();
      else trigger.current?.focus();
    };
  }, [open, reset]);
  const trap = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !sheet.current) return;
    const items = [...sheet.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || !sheet.current.contains(at))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (at === last || !sheet.current.contains(at))) {
      e.preventDefault();
      first.focus();
    }
  };

  // EIP-6963 wallets are listed by name on every device, phones included. The generic row is shown only
  // when no named wallet announced itself and a legacy window.ethereum exists. "Open in" links are the
  // phone fallback when no injected wallet is available at all.
  const named = connectors.some((c) => c.type === "injected" && c.id !== "injected");
  const listed = [...connectors.filter((c) => c.type === "injected"), ...connectors.filter((c) => c.type !== "injected")].filter(
    (c) => !(c.id === "injected" && (named || !legacy)),
  );
  const showOpenIn = phone && !legacy && !named;
  const label = (c: Connector) =>
    c.id === "injected" ? "Browser wallet" : c.id === "coinbaseWalletSDK" && phone ? "Coinbase Smart Wallet" : c.name;
  const icon = (c: Connector) => c.icon ?? WALLET_ICONS[c.id];

  if (isConnected && address) {
    if (chainId !== d.chain.id && connector)
      return (
        <div className="wallet-wrap">
          <button
            className="btn btn-primary"
            onClick={() => {
              setSwitchErr(undefined);
              switchToChain(connector, d).catch((e) => setSwitchErr(explainError(e).text));
            }}
          >
            Switch to {d.network.name}
          </button>
          {switchErr && <p className="note note-error wallet-note" role="alert">{switchErr}</p>}
        </div>
      );
    return (
      <div className="wallet-wrap">
        <button ref={trigger} className="btn btn-quiet mono" aria-expanded={menu} aria-haspopup="true" onClick={() => setMenu(!menu)}>
          {short(address)}
        </button>
        {menu && (
          <div className="menu" role="menu">
            <a role="menuitem" className="menu-row" href={`${d.network.explorer}/address/${address}`} target="_blank" rel="noreferrer">
              View on explorer
            </a>
            <button role="menuitem" className="menu-row" onClick={() => { setMenu(false); disconnect(); }}>
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }
  return (
    <>
      <button ref={trigger} className="btn btn-primary" onClick={() => setOpen(true)}>
        Connect
      </button>
      {open &&
        createPortal(
          <div className="sheet-bg" onClick={() => setOpen(false)}>
            <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" ref={sheet} onClick={(e) => e.stopPropagation()} onKeyDown={trap}>
              <div className="sheet-head">
                <h2 id="sheet-title">Connect a wallet</h2>
                <button className="x" aria-label="Close" onClick={() => setOpen(false)}>
                  ×
                </button>
              </div>
              <div className="sheet-rows">
                {showOpenIn &&
                  OPEN_IN.map((w) => (
                    <a key={w.id} className="row" href={w.href(location.href)}>
                      <img width={28} height={28} src={WALLET_ICONS[w.id]} alt="" />
                      <span>Open in {w.name}</span>
                    </a>
                  ))}
                {listed.map((c) => (
                  <button key={c.uid} className="row" onClick={() => connect({ connector: c })} disabled={isPending}>
                    {icon(c) ? <img width={28} height={28} src={icon(c)} alt="" /> : <span className="ic-blank" aria-hidden="true" />}
                    <span>
                      {label(c)}
                      {isPending && variables?.connector === c ? " · opening…" : ""}
                    </span>
                  </button>
                ))}
                {error && <p className="note note-error">{explainError(error).text}</p>}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
