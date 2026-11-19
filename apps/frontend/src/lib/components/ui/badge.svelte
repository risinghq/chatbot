<script lang="ts">
import type { Snippet } from "svelte";

type Props = {
  variant?: "default" | "success" | "error" | "warning" | "info" | "accent";
  class?: string;
  children: Snippet;
};

let { variant = "default", class: className = "", children }: Props = $props();

const baseStyles =
  "inline-flex h-5 items-center gap-1 rounded-sm px-1.5 text-xs font-medium whitespace-nowrap";

const variants = {
  default: "bg-sunken text-fg-muted",
  success: "bg-success-soft text-success-text",
  error: "bg-danger-soft text-danger-text",
  warning: "bg-warning-soft text-warning-text",
  info: "bg-info-soft text-info-text",
  accent: "bg-accent-soft text-accent-text",
};
</script>

<span class="{baseStyles} {variants[variant]} {className}">
	{@render children()}
</span>
