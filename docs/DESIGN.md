# DESIGN.md: test staking

> Location note: the brief asks for `DESIGN.md` at the repository root, but this assignment may only write `web/**`, `dist/**` and `docs/**`. This file is the design document; the publisher can copy it to the root unchanged.

Source of truth: `web/src/styles.css` (custom properties in `:root`, components below it), `web/src/App.tsx`, `web/src/wallet.tsx`, `web/index.html`, `web/public/favicon.svg`. Rendered confirmation: taste@1 probe screenshots at 320, 390 and 1440 wide, and the Playwright e2e screenshots (see VALIDATION.md).

## Overview

A light, quiet tool page for one task: give testAdam, claim gifts, buy testAdam. Warm off-white background, white bordered cards, one green accent that marks the single primary action in each view. No hero art, gradients or decorative motion. The headline pair, "Give testAdam. Keep the points." with one plain line under it, sits directly above live state and the action card.

## Colors (`:root` in styles.css)

| Token | Value | Role |
| --- | --- | --- |
| `--bg` | `#f6f5f1` | page background, tab track, sheet close button |
| `--surface` | `#ffffff` | cards, inputs, stats, menu, sheet |
| `--surface-hover` / `--surface-press` | `#f0efe9` / `#e7e5dd` | hover and pressed states of secondary controls and sheet rows |
| `--text` | `#1c1c21` | body text, headings |
| `--muted` | `#55555f` | labels, hints, secondary values |
| `--border` | `#d6d4cb` | card, input and row borders, gift separators |
| `--accent` / `--accent-hover` / `--accent-press` | `#1d6b47` / `#17583a` / `#114630` | primary button fill and states, links, success notes, checkbox |
| `--on-accent` | `#ffffff` | text on the accent |
| `--danger` / `--danger-bg` | `#b42318` / `#fdf0ee` | errors, invalid input text, wrong-network banner background |
| `--ok-bg` | `#edf6f0` | reserved success surface (defined, currently unused) |
| `--warn` | `#8a4b00` | "Zero active liquidity" flag |
| `--focus` | `#1c1c21` | 2px focus ring, offset 2px |

The taste@1 contrast check passed at all three widths (it measures the rendered text against its background).

## Typography

- Families: `--font` is the system UI stack. `--mono` (`ui-monospace`…) is used only for addresses, hashes and the pool key (`.mono`, 13px).
- Scale, 5 sizes: `--fs-sm` 13px (labels, hints, notes), `--fs-base` 15px (body), `--fs-md` 17px (brand), `--fs-lg` 20px (h2, amount inputs, sheet ×), `--fs-xl` 30px (h1).
- Weights, 3: 400 body, 600 (`--fw-medium`) h2/labels/buttons/values, 700 h1 only, so the headline is the heaviest type.
- h1 line-height 1.15 and letter-spacing -0.02em; body 1.5. Headings use `text-wrap: balance` and paragraphs use `pretty`. Changing numbers use `font-variant-numeric: tabular-nums`. Long values wrap (`overflow-wrap: anywhere` on `.wrap`, stats and addresses) and are never truncated. The one-word "Unavailable" stat is the exception: it keeps normal wrapping at the smaller size.

## Layout

- One column, max 960px, 16px side padding (`.page`, `.top`, `.foot`). Every grid uses `minmax(0, 1fr)` tracks so long content cannot widen the page.
- Spacing steps: 4 / 8 / 12 / 16 / 24 / 32px (`--space-1`…`--space-6`). Gaps within a group are 4–12px and gaps between sections 16px.
- Order: header (wordmark left, wallet control right), intro (h1 and lede, 32px top padding), stats row (3 columns; at ≤380px 2 + 1), action card (Donate | Buy with ETH tabs), Gifts, Pool, Contracts, footer.
- At ≥860px the page becomes two columns: intro and stats span both, the action card spans two rows on the left, and Gifts, Pool and Contracts flow on the right.
- `.kv` definition lists use a 11rem label column and stack to one column at ≤380px.
- The connect sheet is a bottom sheet under 640px and centered above it.

## Elevation & depth

Structure comes from borders (cards, stats, inputs, rows). Elevation comes from a shadow on the two overlays only: the header menu (`0 8px 24px rgb(0 0 0 / .14)`, no border) and the sheet over a `rgb(20 20 24 / .45)` backdrop. No surface has both a border and a shadow, and no card sits inside a card.

## Shapes

`--radius` 12px for cards and the sheet, `--radius-sm` 8px for buttons, inputs, stats and rows, 6px for tabs, menu rows, icons and ×.

## Components

- **Buttons** (`.btn`): 44px min height, 600 weight. Variants: `.btn-primary` (accent fill, one per view), `.btn-secondary` (surface with border), `.btn-quiet` (connected address), `.btn-wide` (full width, may wrap), `.btn-sm` (40px, gift rows). States: hover only under `(hover: hover)`, pressed, `:focus-visible` ring, disabled at 45% opacity. Transitions cover background-color and border-color only, 120ms, and are removed under reduced motion.
- **Connect control and sheet** (`wallet.tsx` `ConnectControl`): Connect, then a modal sheet (portaled to `<body>`, `#root` made `inert`, Tab and Shift+Tab kept inside, focus returned to whichever control opened it). It lists EIP-6963 wallets by name with their own icons on every device, then Coinbase Wallet ("Coinbase Smart Wallet" on phones). Phones with no injected wallet at all see "Open in" rows instead; the generic "Browser wallet" row appears only when a legacy `window.ethereum` exists and no named wallet announced itself. Rows are 48px with a 28px mark. The sheet is capped at `100dvh` (centered: `100dvh − 32px`); its title and × stay fixed and the rows scroll in `.sheet-rows`. It closes by backdrop, Escape or ×. Connected, the control shows the short address and opens a menu with "View on explorer" and "Disconnect". On the wrong chain it reads "Switch to Sepolia".
- **Tabs** (`.tabs`/`.tab`, ARIA tablist): a two-segment control on the `--bg` track. The selected tab has a surface fill and a 1px outline. Roving `tabindex` (selected 0, other −1); Left/Right/Home/End move focus and selection. Both tab panels stay in the DOM and the inactive one is `hidden` (a global `[hidden] { display: none !important }` keeps class display rules from overriding it), so a pending transaction keeps its status across tab switches.
- **Amount field** (`.field`, `.input-wrap`): a visible `<label for>`, a 52px input at 20px type, a unit suffix, a balance shortcut beside the label, and a hint line linked by `aria-describedby` that turns red with a fix when invalid. Amounts are read and written in the browser locale (`format.ts`): one decimal separator, grouping only in valid groups of three, and the placeholder, balance shortcut and validation example use the same separators ("1,5" in French).
- **Retry row** (`.retry`): an error note and a small secondary "Retry gifts" / "Retry quote" / "Retry wallet details" button that wrap together. "Retry wallet details" sits under the stats row when the connected account's reads fail. With no earlier read it says the balance and points couldn't be read. After an earlier good read it keeps the values and says when they were last checked (UTC).
- **Unavailable stat** (`.stats .stat-off`): a failed account read shows "Unavailable" in `--fs-sm`, regular weight, `--muted`, without mid-word breaking, so it reads as missing data rather than a value or a load in progress ("…").
- **Two-step actions** (`.steps`): "1. Approve" (secondary) and "2. Donate" (primary), side by side.
- **Status note** (`TxStatus`, `.note`): a `role="status"` line for checking, confirm in wallet, waiting for block, then the receipt-derived result or a plain error, with a "View transaction" link.
- **Banner** (`.banner`): the wrong-network message with a "Switch to Sepolia" button.
- **Key/value list** (`.kv`): quote, pool and contracts data.
- **Gift row** (`.gift`): id, amount, donor link, then a status ("✓ Claimed", "Open · your gift") or a Claim button. Claim status is held by the Gifts list, keyed by gift id, not by the row.
- **Hidden claim results** (`.claim-results`, `role="group"`, captioned "Your claims hidden by Open only"): when Open only hides a row that has a claim status from this visit, the id and its status note (result or race message and "View transaction") stay above the list. Unchecking the filter moves the note back into its row, so it never appears twice.
- **Disclosure** (`details.disclosure`): "Before you donate", holding the two README disclosures.

## Do's and Don'ts

- Do read every address, chain and RPC from `imd-deployment.json`. Never add a second map.
- Do keep one accent-filled button per view, and keep transaction buttons disabled until the wallet, chain, amount, balance and approval allow them.
- Do report outcomes from receipts and state read again.
- Don't add kicker labels, uppercase tracking, gradients, emoji or em dashes in interface text.
- Don't truncate addresses or amounts. Wrap them.
- Don't add a sixth type size or a fourth weight.
