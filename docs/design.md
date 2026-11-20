# Dashboard design

This page owns the dashboard's visual rules. The values live in
[`lib/styles/tokens.css`](../apps/frontend/src/lib/styles/tokens.css); this page
says what each one is for. [The dashboard](./dashboard.md) covers routes and
data.

The look follows GitButler's desktop app: the font, the neutral grays, the teal
accent and the soft status colours are taken from its `but-ui` tokens. The UI is
quiet: gray surfaces, one accent, and colour only where it carries meaning.

## Theme

The theme follows the system. Every colour is a `light-dark()` pair and `:root`
sets `color-scheme: light dark`, so no class or toggle exists. Check a change in
both themes.

## Tokens

`tokens.css` resets Tailwind's defaults (`--color-*: initial` and the same for
fonts, sizes, weights, radii, shadows and easings). A default class such as
`bg-gray-100`, `text-2xl` or `rounded-xl` therefore renders nothing. Use only
the names below.

### Colour roles

Components read roles, never the `neutral-N` steps.

| Role                                       | Use                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `canvas`                                   | Page background behind the cards.                                                  |
| `surface`                                  | Cards, tables, inputs, the sidebar.                                                |
| `sunken`, `sunken-strong`                  | Inset areas, default badges, the selected row.                                     |
| `fg`                                       | Primary text.                                                                      |
| `fg-muted`                                 | Secondary text: labels, descriptions, metadata.                                    |
| `fg-subtle`                                | Placeholders, icons and separators. Too faint for text a reader needs.             |
| `border-subtle`, `border`, `border-strong` | Dividers, control outlines, hovered outlines.                                      |
| `hover`                                    | Background of a hovered row or ghost button.                                       |
| `ring`                                     | Focus outline.                                                                     |
| `accent`, `accent-soft`, `accent-text`     | The primary action, the active state, links.                                       |
| `danger`, `success`, `warning`, `info`     | Status. Each has `-soft` for a background and `-text` for text on that background. |
| `inverse`, `on-solid`, `overlay`           | Inverted fills, text on a solid fill, the modal backdrop.                          |

A solid status colour (`bg-danger`) is for a button. A badge or banner uses the
`-soft` background with `-text` text.

### Type

Inter is the sans font. Geist Mono is for identifiers a person copies or
compares: ids, order numbers, emails, phone numbers, DNIs and JSON. Money,
counts and dates are sans with `tabular-nums`. Phase names and other labels are
sans.

| Size   | Use                                         |
| ------ | ------------------------------------------- |
| `xl`   | The page heading.                           |
| `lg`   | A large figure.                             |
| `md`   | A card title or a total.                    |
| `base` | Body text and controls. The default.        |
| `sm`   | Secondary lines, table metadata, help text. |
| `xs`   | Badges and small labels.                    |

There are two weights: `normal` (460) for text and `medium` (580) for headings,
buttons and emphasis. Text is sentence case. Do not uppercase labels.

### Shape and motion

Radii are `sm` for controls and badges, `md` for cards, and `lg` for modals and
sheets. Shadows are `sm` for menus and `md` for modals; cards use a border, not
a shadow. Transitions last 150 ms with `ease-out`; `ease-popup` is for elements
that enter. `prefers-reduced-motion` turns them off globally.

## Layout

The dashboard layout draws the sidebar at `md` and up, and a top bar with a
drawer below it. Every page renders inside the `Page` component, which owns the
one container (`max-w-6xl`) and its padding. A page never sets its own max-width
or page padding, so the heading sits at the same place on every page.

A single-column page (a form, a record, the account page) passes
`width="narrow"`. That caps the content at `max-w-3xl` on the same left edge; it
does not centre a narrower column. Conversations and the simulator are
full-bleed panes with no container. A page under `admin/` renders inside the
admin layout, which already draws the `Page`, the heading and the tabs.

Touch targets grow to 44 px on a coarse pointer (`pointer-coarse:min-h-11`).
Pages must not scroll sideways at 390 px; a wide table scrolls inside its card.

## Components

The primitives are in
[`lib/components/ui/`](../apps/frontend/src/lib/components/ui/) and the page
scaffolding in
[`lib/components/shared/`](../apps/frontend/src/lib/components/shared/). Reach
for these before writing classes.

| Component                                  | Use                                                                                                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                                   | `primary` for the one main action of a view, `secondary` for the rest, `ghost` for toolbar and row actions, `danger` for a destructive confirm. Sizes `sm`, `md`, `lg`. |
| `Badge`                                    | A short status. `default`, `success`, `error`, `warning`, `info`, `accent`.                                                                                             |
| `Banner`                                   | A message that stays on the page, with `info`, `warning`, `danger` or `success` tone and an optional action. Transient feedback is a toast.                             |
| `SectionShell`                             | A card with a title, description, body and optional footer. Forms and settings groups use it.                                                                           |
| `FormField`, `Input`, `Select`, `Textarea` | A labelled control with help and error text.                                                                                                                            |
| `DataTable`                                | A table from a column list. It scrolls sideways inside its card when narrow.                                                                                            |
| `Modal`, `Sheet`                           | A confirm or short form; a side panel for a record.                                                                                                                     |
| `EmptyState`                               | What an empty list shows, with the next step.                                                                                                                           |
| `Page`                                     | The page container. `width="narrow"` for a single column.                                                                                                               |
| `PageHeader`, `PageTitle`                  | The visible heading with actions; the browser tab title.                                                                                                                |
| `NeedsTenant`                              | What a business-scoped page shows when no business is active.                                                                                                           |

Write UI text in Spanish, for the staff who use it, and name the next step
rather than the system state.
