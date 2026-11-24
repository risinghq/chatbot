<script lang="ts">
import type { Snippet } from "svelte";
import SiteHeader from "./site-header.svelte";
import SiteFooter from "./site-footer.svelte";

type Props = {
  user?: App.Locals["user"];
  children: Snippet;
};

let { user = null, children }: Props = $props();
</script>

<div class="flex min-h-dvh flex-col">
	<SiteHeader {user} />
	<main id="main" class="flex-1">
		{@render children()}
	</main>
	<SiteFooter />
</div>
