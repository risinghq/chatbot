<script lang="ts">
import type { Snippet } from "svelte";

type Props = {
  onclick?: () => void;
  disabled?: boolean;
  class?: string;
  children: Snippet;
};

let {
  onclick,
  disabled = false,
  class: className = "",
  children,
}: Props = $props();
</script>

<button
	type="button"
	data-dropdown-item
	{disabled}
	{onclick}
	class="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-base text-fg transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-11 touch-manipulation {className}"
	role="menuitem"
	tabindex={disabled ? -1 : 0}
>
	{@render children()}
</button>
