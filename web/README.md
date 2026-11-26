# test staking: frontend

The static site for the Sepolia launch of `LaunchToken` (testAdam) and `DonationVault`. It is built with Vite, React and TypeScript, using wagmi and viem. The static export goes to the repository-root `dist/`, uses a relative base (`./`), and has no server and no routes.

## What it does

- **Wallet:** one Connect control. Browser wallets are discovered by EIP-6963. On a phone there are "Open in MetaMask / Coinbase Wallet / Phantom" links, plus Coinbase Smart Wallet. There is no relay and no project ID. On the wrong chain the control reads "Switch to Sepolia". It sends `wallet_switchEthereumChain`, and if the wallet answers 4902 or "unknown chain", it sends `wallet_addEthereumChain` with the manifest's `walletAddChain` and then switches again.
- **Live state:** wallet testAdam balance, donor points, total unclaimed gifts, and the allowance and ETH balance used by the forms. These reload every 20 s and after every receipt.
- **Donate:** the amount is parsed with 18 decimals in the browser locale (French "1,5" is 1.5; English "1,5" is rejected, never read as 15). Approve sets the vault allowance to exactly the entered amount; Donate is a separate second step. The disclosure text from the contract README sits beside the form.
- **Gifts:** read with `giftCount` and `getGift`, newest first, 10 per page. Each gift shows its amount, donor and claim status. Open gifts from other donors have a Claim button. If another wallet already claimed the gift, the `AlreadyClaimed` revert refreshes the list instead of reporting a payout.
- **Buy with ETH:** quoted with the v4 Quoter `quoteExactInputSingle` (a simulation, not a transaction). The panel shows the minimum received at the chosen slippage, the rate, the quote's remaining life (30 s, then "Refresh quote") and the deadline. A buy runs Universal Router `execute(0x10, [V4_SWAP: 0x060c0f], deadline)` with `value = amountIn` against the exact handoff pool key. It is simulated before the wallet opens. The quote is fetched again when the amount, account or chain changes.
- **Pool:** price, active liquidity and FDV are read at one finalized block, with block number and UTC time. Circulating market cap is shown as unavailable, with the reason. The 24 h volume is the absolute sum of the ETH leg of each distinct `Swap`, starting no earlier than pool initialization; a partial scan is marked unavailable.
- **Results come from receipts:** after a transaction the page reports the `Donated`, `Claimed` or `Transfer` events in the receipt, or state read again. It never reports the simulation's result.

## Configuration: one file

At runtime the app loads `./imd-deployment.json` and then the ABI files it lists (`abi/LaunchToken.json`, `abi/DonationVault.json`). Addresses, chain id, public RPC URLs, explorer, Uniswap v4 addresses, the pool key and the add-chain parameters all come from that file (`src/deployment.ts`). No other address or chain map exists. Uniswap *interfaces* (function signatures only) are in `src/uniswap.ts`.

`imd-deployment.json` is generated after the build by `scripts/emit-deployment.mjs` from:

- `deployment/handoff.json`: an exact copy of the workflow deployment handoff (launch id, chain, source commit, attestation, contracts, pool key).
- `deployment/network.json`: an exact copy of the vetted chain table entry (`network` and `walletAddChain`).
- `../docs/abi/<Contract>.json`: the implementation-derived ABIs at the deployed source commit. Each one is checked against the handoff `abiHash` with the canonical keccak (sorted keys, no whitespace; see `scripts/abi-hash.mjs`), and the build fails on a mismatch.

The script lists every other exported file with its SHA-256. To deploy a different handoff, replace the two JSON files and rebuild. The bundle holds no private RPC URL, key or secret.

## Install, build, preview

```sh
cd web
npm ci                 # installs from package-lock.json
npm run typecheck      # tsc, no emit
npm test               # vitest unit tests (amount parsing, pool id, price math, swap encoding, volume sum)
npm run build          # typecheck + vite build to ../dist + emit dist/imd-deployment.json
npm run verify         # checks dist/imd-deployment.json against handoff, network table, ABI hashes, file hashes
npx vite preview --outDir ../dist   # or serve ../dist with any static file server
```

Rebuild after any source change. The build regenerates `dist/` and the manifest, and both are committed. `vite dev` does not serve the manifest. Use a build and preview instead.

## Validation

See [`../docs/VALIDATION.md`](../docs/VALIDATION.md) for commands, the browser interaction runs (Sepolia fork and mocked RPC), the design-review probe results, the Better Interface review and what was not tested on the live chain. The design system is documented in [`../docs/DESIGN.md`](../docs/DESIGN.md).
