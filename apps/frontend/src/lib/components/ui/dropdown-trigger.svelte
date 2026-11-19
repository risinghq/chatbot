<script lang="ts">
import type { Snippet } from "svelte";

type Props = {
  onclick?: () => void;
  disabled?: boolean;
  open?: boolean;
  class?: string;
  children: Snippet;
};

let {
  onclick,
  disabled = false,
  open = false,
  class: className = "",
  children,
}: Props = $props();
</script>

<button
	type="button"
	{disabled}
	{onclick}
	aria-haspopup="true"
	aria-expanded={open}
	class="{className} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 touch-manipulation"
>
	{@render children()}
</button>
