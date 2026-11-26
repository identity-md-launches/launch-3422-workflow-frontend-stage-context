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
- At first check the finalized block (12212724) was **earlier** than the initialization (and the token deployment), so StateView returned `sqrtPriceX96 = 0` and liquidity 0 there, and `totalSupply()` at that block returned `0x`. **Correction (revision round):** the previous build did not handle this; the failed `totalSupply` read hid the whole panel behind "Pool data did not load". The panel now checks the token's code at the finalized block first (`web/src/pool.ts:70`) and shows the block, UTC time, "Not initialized at this block", "Zero active liquidity at this block" and FDV "Unavailable. The token has no code at this block". This was checked in the mocked-RPC browser run below, not against the live chain.
- Quoter `quoteExactInputSingle` for 0.001 ETH returned 49,154.238 testAdam (a simulation). `giftCount()` was 0.

## Commands and results

| Command (from `web/`) | Result |
| --- | --- |
| `npm run typecheck` (`tsc -b --noEmit`) | passed, no errors |
| `npm test` (vitest, `src/logic.test.ts`) | 9/9 passed: amount parsing and formatting, including locale cases (fr-FR "1,5" → 1.5, "0,01" → 0.01, "1 000,5" → 1000.5, "1,5,5" rejected; en-US "1,5" and "0,01" rejected rather than read as 15 and 1; de-DE "1.000,5" → 1000.5 and "0.01" rejected) and round-tripping the balance shortcut, pool id equal to the on-chain id, sqrtPriceX96 conversion in both currency orders, distinct-swap ETH-leg sum, slippage rounding, full decode of the `execute` payload (commands `0x10`, actions `0x060c0f`, 5-field ExactInputSingleParams with the handoff key, SETTLE_ALL and TAKE_ALL params) |
| `npm run build` | vite build to `../dist`, then manifest: 2 contracts, 11 assets, 1,417,049 bytes total (largest file 578 KB) |
| `npm run verify` | `ok: true`. It checks the key set; that launchId, chainId, sourceCommit, attestationHash, poolKey and contracts equal the handoff; that network and walletAddChain equal `network.json` byte for byte; ABI hashes; that every file is listed with the right SHA-256; relative paths; and that index.html has no root-absolute asset URLs |

## Revision round: reviewer findings reproduced and rechecked (Chromium, mocked RPC and wallet)

Script: `test/scratch/e2e.mjs` (not submitted). It loads the built `dist/` export from a gateway-style subpath (`http://site.test/preview/`). Every request to the manifest's three public RPC URLs is answered by a JSON-RPC mock in the script (batched calls, `eth_call` decoded against the exported ABIs, receipts, logs, blocks), and a mock EIP-6963 wallet records every `eth_sendTransaction` and either rejects it (4001) or returns a hash whose receipt the test controls. No public RPC or chain was contacted. Chromium is Playwright's headless shell, run with system libraries and fonts unpacked into the scratch directory (this machine has neither). **Final run: 43/43 passed, no console errors, no requests outside the site and the mocked RPCs.**

- **Decimal commas** (fr-FR locale): the placeholder reads "1,5". Typing "1,5" and choosing Approve sends `approve(vault, 1500000000000000000)`. "1,5,5" is rejected with a hint that uses "1,5". Buying "0,01" quotes `exactAmount` 0.01 ETH, and both the router simulation and the wallet request carry `value` 0.01 ETH.
- **Quote expiry during simulation:** Buy clicked with 1–3 s left on the quote while the router `eth_call` is held for 5 s. The page shows "Quote expired. Refresh quote, then choose Buy again. Nothing was sent." and **no** wallet request is made. The real deadline is shown ("Last buy: reverts if not mined by 2026-11-26 01:02:54 UTC"), the select is labelled "Transaction deadline", and refreshing the quote needs a new Buy click.
- **Pending buy:** with a pending receipt, changing the amount to 0.02 requotes but keeps "Waiting for the buy to be mined. View transaction" and keeps Buy disabled. Switching to Donate and back keeps the note and link.
- **Confirmed buy with a failing balance read:** a `status 0x1` receipt with a 1,000 testAdam Transfer, and `balanceOf(wallet)` at the receipt block returning an error. The note stays green: "Bought 1,000 testAdam for 0.01 ETH in block … Balance unavailable. Refresh to try again. View transaction".
- **Gift claimed elsewhere:** gift #1 flipped to claimed in the fixture (giftCount unchanged). The row turns "Claimed" within one 20 s cycle. Gift #2 passes the claim preflight, then its receipt comes back reverted after another wallet claimed it: the row reads Claimed and shows "Another wallet claimed this gift first." No Claim #2 button remains.
- **Gift read errors:** `getGift` errors on every RPC. The panel shows "Gift details couldn’t be loaded." with "Retry gifts", never the empty-list message. Retry loads the list once the RPC recovers.
- **Pool:** with StateView reporting the pool initialized and no Initialize log found, the panel shows "Volume unavailable. The pool initialization block could not be verified." and makes zero Swap queries. With a finalized block before the token existed, the block, UTC time, zero active liquidity and FDV unavailable are shown.
- **Quotes:** a 0 testAdam quote shows "This amount buys 0 testAdam. Enter a larger amount." with no validity timer, and Buy stays disabled. A provider error shows "Quote unavailable: …" with "Retry quote", no liquidity advice, and Retry recovers. A Quoter `NotEnoughLiquidity` revert shows "Insufficient liquidity for this amount. Enter less."
- **Wallet sheet:** opened from "Connect a wallet to donate". Tab from the last row and Shift+Tab stay inside the sheet, `#root` is `inert` while it is open, and Escape returns focus to "Connect a wallet to donate". At 390 × 240 the sheet spans y = 68–240, Close is at y = 84, and `.sheet-rows` has `overflow-y: auto`.
- **Phone wallets:** with an iPhone user agent and no `window.ethereum`, an announced EIP-6963 wallet is listed by name. With nothing announced, the three "Open in" rows and Coinbase Smart Wallet appear.
- **Tabs:** Right Arrow on the selected Donate tab moves focus and selection to "Buy with ETH" and shows its panel. Both panels exist, and the inactive one is hidden. Tabindex is 0 on the selected tab and −1 on the other. The first run found a real defect here: `.panel { display: grid }` overrode `hidden`, so both panels showed. It is fixed by a global `[hidden]` rule (`web/src/styles.css:533`).
- No horizontal scroll at 390 or 320 while connected with a confirmed-buy note.

Not run this round: **WebKit**. Playwright's WebKit needs GTK 4, GStreamer and about 40 other system libraries that this machine lacks, and they could not be installed without root. The anvil-fork run described below was done in the previous round and was **not repeated** against this build. The changes above were checked only against the mocked RPC.

## End-to-end interaction test, previous round (Chromium, anvil fork of Sepolia)

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

`node .imd/reads/skills/design-critic/scripts/taste.mjs --out test/scratch/taste` (Playwright from `~/.imd-taste` in the previous round; this round from `test/scratch/pw` via `IMD_PLAYWRIGHT`). **Final, rerun on this round's export: 16/16** (render, layout, targets, contrast, casing, tracking, eyebrows, type-sizes, type-faces, glyphs, slogans, repetition, copy-budget, chrome, motion, share). Earlier runs failed `layout` at 320 (8px overflow), `eyebrows` (the Connect button within 40px above the h1) and `copy-budget` (63 words at 390, 105 at 1440); all three were fixed, see below. The 390 screenshot was viewed: header with Connect, the headline pair, three live stats, and the Donate/Buy card with amount field, the one-line points rule and the main button are all on the first screen.

## Better Interface review

Guide: `.imd/reads/skills/better-interface/REFERENCE.md`. I read the workflow and the core principles of all six domains and applied them while building. Rendered checks came from the Playwright runs above (screenshots at 320, 390 and 1440, keyboard Escape on the sheet, live interaction). The Playwright MCP browser tool was not available; screenshots came from Playwright scripts.

| Domain | Status | Evidence |
| --- | --- | --- |
| Accessibility | Checked | Native buttons, links and inputs. Every input has a `<label for>`. `aria-invalid` and `aria-describedby` on amount fields. `role="status"` transaction notes and `role="alert"` errors. Tablist roles. Dialog with `aria-modal`, Escape and focus return to the trigger. Skip link, one h1, ordered h2s. 2px `:focus-visible` ring. Status is not color-only ("✓ Claimed", text errors). Probe `targets` passed. Sheet focus trap, inert background, focus return and tab arrow keys were checked by script this round. **Not performed:** screen-reader session, forced-colors mode, native 200% zoom (only 320px reflow was checked), full keyboard tab walk of the whole page. |
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

Revision-round findings and fixes (each rechecked in the mocked-RPC run above):

8. **HIGH, behavior/writing:** the amount parser deleted every comma, so French "1,5" became 15. It now parses in the browser locale (`web/src/format.ts:56`), and the placeholder, balance shortcut and hint use the same separators.
9. **HIGH, behavior:** the quote age is checked again after the simulation, before the wallet opens (`web/src/App.tsx:456`). The deadline copy now matches the encoded value (`web/src/App.tsx:571`).
10. **HIGH, behavior:** editing the amount or switching tabs cleared a pending transaction's status. Only finished feedback is cleared now (`web/src/App.tsx:97`), and both panels stay mounted.
11. **HIGH, behavior:** a confirmed receipt is shown at once from its logs. Follow-up reads fail on their own ("Balance unavailable…") without turning the confirmation into an error (`web/src/App.tsx:74`). Receipts are read with viem's wait, which returns a reverted receipt instead of throwing.
12. **HIGH, behavior:** gift rows are reread every 20 s (`web/src/App.tsx:601`). A failed claim, including a mined revert, rereads the gift and reports the race (`web/src/App.tsx:695`).
13. **HIGH, writing:** gift read errors have their own state with "Retry gifts" (`web/src/App.tsx:637`).
14. **HIGH, fidelity:** zero volume is shown only when StateView proves the pool uninitialized at the block (`web/src/pool.ts:89`) or after a complete scan from a verified Initialize. Otherwise volume is unavailable (`web/src/pool.ts:124`).
15. **HIGH, writing:** the donation hint states that points are nontransferable (`web/src/App.tsx:351`), and so does the disclosure.
16. **HIGH, accessibility:** the wallet sheet is modal (inert background, focus trap, focus returned to the opener: `web/src/wallet.tsx:141`, `:150`) and fits short viewports (`web/src/styles.css:557`).
17. **MEDIUM, behavior:** EIP-6963 wallets are listed on phones (`web/src/wallet.tsx:173`).
18. **MEDIUM, accessibility:** tabs use a roving tabindex and arrow keys (`web/src/App.tsx:168`).
19. **MEDIUM, writing:** quote errors are classified (`web/src/wallet.tsx:72`). A zero quote, missing liquidity and a provider failure each get their own next step (`web/src/App.tsx:547`).

Remaining limitations: the README disclosures sit in a "Before you donate" `<details>`. The essential rule ("Only Donate creates a gift and earns points…") is always visible beside the form, but the full disclosure text needs one tap. The stats show "Connect to see" on two lines at 390. The share image path is relative (`./og.png`) because the hosted URL is not known yet.

## Contract behavior notes

- Neither contract checks `gasleft()` or forwards a fixed gas amount. The vault calls the token with all available gas, and a failure reverts `TransferFailed`. Approve, donate, claim and the router swap all succeeded on the fork with `estimateGas × 1.1`, and their effects were confirmed through events and state read again.
- Points are farmable through a second wallet, and direct transfers lock tokens forever. The page shows both disclosures beside the donation form.

## Not tested on the live chain

No transaction was broadcast to Sepolia. Approve, donate, claim and buy were exercised only on a local anvil fork with a mock wallet. Not exercised: real wallet extensions, phone "Open in" links, Coinbase Smart Wallet passkeys, real mempool timing or price movement between quote and inclusion (`V4TooLittleReceived` handling is mapped but was not triggered), public RPC rate limits or `eth_getLogs` range limits on the 24 h scan (a failed chunk is marked "Unavailable: partial scan"), and the historical `eth_getCode` binary search that finds the initialization lower bound on non-archive public RPCs (if it fails, volume is marked unavailable). WebKit was not run (see the revision round). Locale handling was checked for fr-FR, en-US and de-DE only.

## Completion

**Complete for the stated scope**, with the limitations above. IPFS publication, CID and naming come after this assignment and are not claimed here.
