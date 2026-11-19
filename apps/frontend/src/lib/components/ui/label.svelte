<script lang="ts">
import type { Snippet } from "svelte";

type Props = {
  for?: string;
  class?: string;
  children: Snippet;
};

let { for: htmlFor, class: className = "", children }: Props = $props();
</script>

<label for={htmlFor} class="mb-1.5 block text-sm font-medium text-fg {className}">
	{@render children()}
</label>
