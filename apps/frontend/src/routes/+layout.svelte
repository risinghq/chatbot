<script lang="ts">
import "#lib/styles/global.css";
import { auth } from "#lib/state/auth.svelte.js";
import ToastContainer from "#lib/components/shared/toast-container.svelte";
import type { LayoutData } from "./$types";

let { children, data }: { children: any; data: LayoutData } = $props();

// The user's role changes with the business in the URL, so the state follows
// each new load, not only the first.
$effect(() => {
  auth.hydrate(data.user ?? null);
});
</script>

{@render children()}
<ToastContainer />
