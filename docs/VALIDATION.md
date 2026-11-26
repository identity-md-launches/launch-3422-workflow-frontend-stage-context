# Frontend validation: test staking

Worker report for the frontend stage. It is not an independent certification. Every check below was run on this worker against the final source and export unless it is marked otherwise.

## Scope and assumptions

- **Scope:** the single page (`web/` source, `dist/` export) for LaunchToken `0x4cc136b358c28cd7107b22a8ef853b077a0b8ec9` and DonationVault `0xa241f03c041f964b37f63b874e81ac810a9739e3` on Sepolia (11155111). It covers wallet connection, live reads, approve → donate, gift browsing and claims, quoted ETH buys, the pool panel and the contracts panel.
- **Handoff:** `launchId 2896cd7a-8746-400d-9809-5e342463e993`, `sourceCommit 29cf2d87ebd12eba43c683766eb2fae4cd5e2811` (the checked-out commit), `attestationHash 02acb510…eeaf`. The pool key is copied exactly: currency0 `0x0`, currency1 the token, fee 12500, tickSpacing 60, hooks `0xa0602cb30558d5dd17415b6268a4feea3a0ca000`.
- **ABIs:** `docs/abi/LaunchToken.json` and `docs/abi/DonationVault.json` at the source commit. Canonical keccak (sorted keys, compact JSON) matches the handoff: `2f13039a…0177` and `1f918199…d7b7`. The build checks this again (`web/scripts/emit-deployment.mjs`).
- **Assumptions:**
  - Circulating supply has no documented, verifiable basis in the handoff (distributor, liquidity and treasury holders are not listed), so circulating market cap is shown as **unavailable** with that reason.
  - No USD source exists, so values are in ETH.
  - The quote is treated as stale after 30 s.
- **Write scope conflict:** `DESIGN.md` is required at the repository root, but this assignment may only write `web/**`, `dist/**` and `docs/**`. The design document is therefore at `docs/DESIGN.md`.

## On-chain facts verified (read-only, through the worker's Sepolia RPC; public endpoint of record `https://ethereum-sepolia-rpc.publicnode.com`)

- `eth_chainId` returns 11155111. Every address has code: token, vault, and all six Uniswap v4 addresses from `network.json`.
- `poolManager()` on the Quoter, StateView, PositionManager and Universal Router all return `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`, the PoolManager in `network.json`.
- Pool id `0xf6b590d823083d9a9b7c10ceb9a990d06b9a1196e6a2dc002a1b1b915393d394`. Its `Initialize` log is in block 12212785, tx `0x72562a80…d234`, the same tx as the contract deployment.
- At check time the finalized block (12212724) was **earlier** than the initialization, so StateView returned `sqrtPriceX96 = 0` and liquidity 0 there. The page handles this case: "Not initialized at this block", "Zero active liquidity at this block", and a 24 h volume note saying the pool was initialized after the block. Once finality passes block 12212785, the same code shows the live price.
- Quoter `quoteExactInputSingle` for 0.001 ETH returned 49,154.238 testAdam (a simulation). `giftCount()` was 0.

## Commands and results

| Command (from `web/`) | Result |
| --- | --- |
| `npm run typecheck` (`tsc -b --noEmit`) | passed, no errors |
| `npm test` (vitest, `src/logic.test.ts`) | 7/7 passed: amount parsing and formatting, pool id equal to the on-chain id, sqrtPriceX96 conversion in both currency orders, distinct-swap ETH-leg sum, slippage rounding, full decode of the `execute` payload (commands `0x10`, actions `0x060c0f`, 5-field ExactInputSingleParams with the handoff key, SETTLE_ALL and TAKE_ALL params) |
| `npm run build` | vite build to `../dist`, then manifest: 2 contracts, 11 assets, 1,410,765 bytes total (largest file 572 KB) |
| `npm run verify` | `ok: true`. It checks the key set; that launchId, chainId, sourceCommit, attestationHash, poolKey and contracts equal the handoff; that network and walletAddChain equal `network.json` byte for byte; ABI hashes; that every file is listed with the right SHA-256; relative paths; and that index.html has no root-absolute asset URLs |

## End-to-end interaction test (Chromium, anvil fork of Sepolia)

Script: `test/scratch/e2e.mjs`. The scratch directory is not submitted; the method is described here. One foreground run starts `anvil --fork-url <Sepolia RPC> --chain-id 11155111` and serves `dist/` under `/preview/` (like a gateway subpath). Chromium's requests to the manifest's public RPC URLs go to the fork. A mock EIP-6963 wallet ("Test Wallet") starts on chain 1 and does not know Sepolia (it answers 4902). It signs with unlocked anvil accounts and sets gas to `estimateGas × 1.1`, as some wallets do. Every transaction ran the deployed bytecode on the fork. **Final run: 41 passed, 1 flagged.**

Passed:

- Loads from the subpath. Disconnected: "Connect to see", unclaimed total read without a wallet (0 testAdam), "No gifts yet", "Connect a wallet to donate". The pool panel shows block, UTC time and coverage, and circulating cap is unavailable with its basis.
- Sheet: the EIP-6963 wallet is listed by name, the generic "Injected" or "Browser wallet" row is hidden, Coinbase Wallet is listed, and Escape closes the sheet.
- Wrong chain: banner shown and Approve disabled. "Switch to Sepolia" gets 4902, then `wallet_addEthereumChain` is sent with params **identical** to the manifest `walletAddChain`, then the switch succeeds and the banner disappears.
- Buy: quote shows amount, minimum received at 1% slippage and "Valid for Ns". Buying 0.01 ETH through the real Universal Router reported "Bought 491,270.7172 testAdam for 0.01 ETH in block … Balance 0 → 491,270.7172", taken from the receipt's Transfer log and a balance read at the receipt block. An amount over the ETH balance shows "You have … ETH. Enter less".
- Donate: Donate stays disabled before approval. A wallet rejection shows "You declined the request in your wallet. Nothing was sent." Approve reported "The vault may now take 1.5 testAdam" (allowance read again). Donate reported "Gift #1 recorded: 1.5 testAdam. Your points are now 1.5." (Donated event and points read again). The gift is listed as "from you · Open · your gift", so the donor gets no claim control.
- Claim: a second wallet sees "Claim #1" and gets "You received 1.5 testAdam from gift #1. Balance now 1.5." (Claimed event). The gift shows Claimed, and the donor's points stay at 1.5 after payout.
- Race: donor makes gift #2 (0.25). A third wallet claims it directly on chain. The second wallet's stale "Claim #2" shows "Another wallet claimed this gift first. The list has been refreshed." and the row becomes Claimed. Points then read 1.75, with fractions counted.
- Quote expiry: after 31 s the button reads "Quote expired. Refresh quote", and refreshing requotes.
- No horizontal scroll at 320, 390 and 1440 (connected, with a 491,270.7172 balance). Disconnect from the header menu returns to Connect. No console errors.

Flagged: one `fetch` of the page's own URL (`/preview/`) ended `net::ERR_ABORTED`, with no console error and no visible effect. It looks like a library request cancelled during load (it is not one of the site's config, ABI or RPC requests). Its origin was not traced.

An earlier run found that the Coinbase Wallet SDK sent a telemetry request to `cca-lite.coinbase.com` on load. Fixed with `preference.telemetry: false` (`web/src/wallet.tsx:15`); later runs show no such request.

## Design review probe (taste@1)

`node .imd/reads/skills/design-critic/scripts/taste.mjs --out test/scratch/taste` (Playwright from `~/.imd-taste`). **Final: 16/16** (render, layout, targets, contrast, casing, tracking, eyebrows, type-sizes, type-faces, glyphs, slogans, repetition, copy-budget, chrome, motion, share). Earlier runs failed `layout` at 320 (8px overflow), `eyebrows` (the Connect button within 40px above the h1) and `copy-budget` (63 words at 390, 105 at 1440); all three were fixed, see below. The 390 screenshot was viewed: header with Connect, the headline pair, three live stats, and the Donate/Buy card with amount field, the one-line points rule and the main button are all on the first screen.

## Better Interface review

Guide: `.imd/reads/skills/better-interface/REFERENCE.md`. I read the workflow and the core principles of all six domains and applied them while building. Rendered checks came from the Playwright runs above (screenshots at 320, 390 and 1440, keyboard Escape on the sheet, live interaction). The Playwright MCP browser tool was not available; screenshots came from Playwright scripts.

| Domain | Status | Evidence |
| --- | --- | --- |
| Accessibility | Checked | Native buttons, links and inputs. Every input has a `<label for>`. `aria-invalid` and `aria-describedby` on amount fields. `role="status"` transaction notes and `role="alert"` errors. Tablist roles. Dialog with `aria-modal`, Escape and focus return to the trigger. Skip link, one h1, ordered h2s. 2px `:focus-visible` ring. Status is not color-only ("✓ Claimed", text errors). Probe `targets` passed. **Not performed:** screen-reader session, forced-colors mode, native 200% zoom (only 320px reflow was checked), full keyboard tab walk. |
| Layout | Checked | Space-based grouping, `minmax(0,1fr)` tracks, two columns at ≥860px. No horizontal scroll at 320, 390 or 1440 (measured). |
| Writing | Checked | Verb-first buttons ("1. Approve", "2. Donate", "Buy testAdam", "Claim #1"). Errors say how to fix them. Empty states point forward ("Donate above to create the first one"). Consistent terms (gift, points, claim). |
| Typography | Checked | 5 sizes, 3 weights, system family plus mono for data only. Tabular numbers. Balanced headings. Probe type checks passed. |
| Colors | Checked | Role tokens in `:root`, one accent fill per view. Probe `contrast` passed at all widths (rendered pairs). Disabled buttons (45% opacity) are excluded from contrast requirements. |
| UI | Checked | Borders for structure and shadow only on overlays. Transitions name their properties and turn off under reduced motion. No `transition: all`, no endless motion (probe `motion` passed). |

Findings and fixes (all rechecked by running the build, probe and e2e again):

1. **HIGH, layout:** 8px horizontal scroll at 320. The amount `<input>`'s intrinsic width set the grid column's min-content. Fixed with `minmax(0,1fr)` columns on `.field`, `.panel`, `.card` and `.page`, `width:0; flex:1 1 0` on the input, and wrapping allowed on `.btn-wide` (`web/src/styles.css:252`, `:283`, `:404`). Recheck: overflow 0 at 320.
2. **MEDIUM, accessibility:** the Donate "Balance" shortcut button was nested inside the field `<label>`, so the label named a button and the input's accessible name included "Balance…". Fixed by moving it beside a separate `<label htmlFor>` (`web/src/App.tsx:241`, `:394`), with an explicit `aria-label` on the shortcut.
3. **MEDIUM, layout/probe `eyebrows`:** the header Connect button sat within 40px above the h1. Fixed with 32px intro top padding (`web/src/styles.css:174`).
4. **MEDIUM, writing/probe `copy-budget`:** 63 words of prose on the first screen at 390. Fixed by shortening the gifts rule (`web/src/App.tsx:517`), turning the gift count into a data line, and shortening the pool note (`web/src/App.tsx:595`).
5. **LOW, UI:** the disclosure `<summary>` had `display:flex`, which hid its disclosure triangle (no cue for hidden content). Fixed with `display:list-item` (`web/src/styles.css:450`).
6. **MEDIUM, privacy:** Coinbase SDK telemetry on page load. Disabled (`web/src/wallet.tsx:15`).
7. **Behavior:** connecting passed `chainId`, which made wagmi switch chains itself with its own add-chain parameters. Removed (`web/src/wallet.tsx:183`), so the visible wrong-network state and the manifest `walletAddChain` path are used.

Remaining limitations: the README disclosures sit in a "Before you donate" `<details>`. The essential rule ("Only Donate creates a gift and earns points…") is always visible beside the form, but the full disclosure text needs one tap. The stats show "Connect to see" on two lines at 390. The share image path is relative (`./og.png`) because the hosted URL is not known yet.

## Contract behavior notes

- Neither contract checks `gasleft()` or forwards a fixed gas amount. The vault calls the token with all available gas, and a failure reverts `TransferFailed`. Approve, donate, claim and the router swap all succeeded on the fork with `estimateGas × 1.1`, and their effects were confirmed through events and state read again.
- Points are farmable through a second wallet, and direct transfers lock tokens forever. The page shows both disclosures beside the donation form.

## Not tested on the live chain

No transaction was broadcast to Sepolia. Approve, donate, claim and buy were exercised only on a local anvil fork with a mock wallet. Not exercised: real wallet extensions, phone "Open in" links, Coinbase Smart Wallet passkeys, real mempool timing or price movement between quote and inclusion (`V4TooLittleReceived` handling is mapped but was not triggered), public RPC rate limits or `eth_getLogs` range limits on the 24 h scan (a failed chunk is marked "Unavailable: partial scan"), and the historical `eth_getCode` binary search that finds the initialization lower bound on non-archive public RPCs (if it fails, volume is marked unavailable). WebKit was not run.

## Completion

**Complete for the stated scope**, with the limitations above. IPFS publication, CID and naming come after this assignment and are not claimed here.
