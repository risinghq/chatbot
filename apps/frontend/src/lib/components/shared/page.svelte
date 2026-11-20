<script lang="ts">
import type { Snippet } from "svelte";

type Props = {
  /**
   * `narrow` caps the content for a single column (a form, a record) but keeps
   * it on the same left edge as every other page, so the heading does not move
   * when the user switches pages.
   */
  width?: "wide" | "narrow";
  children: Snippet;
};

let { width = "wide", children }: Props = $props();
</script>

<div class="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
	<div class={width === "narrow" ? "max-w-3xl" : ""}>
		{@render children()}
	</div>
</div>
