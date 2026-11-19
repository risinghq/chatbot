<script lang="ts">
import type { Snippet } from "svelte";

type Props = {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  class?: string;
  type?: "button" | "submit" | "reset";
  href?: string;
  onclick?: (e: MouseEvent) => void;
  "aria-label"?: string;
  children: Snippet;
};

let {
  variant = "primary",
  size = "md",
  disabled = false,
  class: className = "",
  type = "button",
  href,
  onclick,
  "aria-label": ariaLabel,
  children,
}: Props = $props();

// A finger needs 44 px, so a coarse pointer raises every size to it.
const sizeStyles = {
  sm: "h-7 px-2.5 text-sm gap-1.5",
  md: "h-8 px-3 text-base gap-1.5",
  lg: "h-10 px-4 text-base gap-2",
};

const baseStyles =
  "inline-flex shrink-0 items-center justify-center rounded-sm font-medium whitespace-nowrap select-none pointer-coarse:min-h-11 transition-[background-color,border-color,color] duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 disabled:pointer-events-none aria-disabled:opacity-50 aria-disabled:pointer-events-none touch-manipulation";

const variants = {
  primary: "bg-accent text-on-solid hover:bg-accent/90",
  secondary:
    "border border-border bg-surface text-fg hover:border-border-strong hover:bg-hover",
  ghost: "text-fg-muted hover:bg-hover hover:text-fg",
  danger: "bg-danger text-on-solid hover:bg-danger/90",
};
</script>

{#if href}
	<a
		{href}
		class="{baseStyles} {sizeStyles[size]} {variants[variant]} {className}"
		tabindex={disabled ? -1 : 0}
		aria-disabled={disabled}
		aria-label={ariaLabel}
	>
		{@render children()}
	</a>
{:else}
	<button
		{type}
		{disabled}
		{onclick}
		aria-label={ariaLabel}
		class="{baseStyles} {sizeStyles[size]} {variants[variant]} {className}"
	>
		{@render children()}
	</button>
{/if}
