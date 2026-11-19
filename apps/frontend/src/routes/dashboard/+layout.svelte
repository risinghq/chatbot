<script lang="ts">
import { afterNavigate } from "$app/navigation";
import { fade, fly } from "svelte/transition";
import AppSidebar from "#lib/components/shared/app-sidebar.svelte";
import Icon from "#lib/components/ui/icon.svelte";

let { children } = $props();

let drawerOpen = $state(false);

afterNavigate(() => {
  drawerOpen = false;
});
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && (drawerOpen = false)} />

<div class="min-h-dvh bg-canvas md:flex">
	<aside class="hidden w-60 shrink-0 border-r border-border-subtle md:sticky md:top-0 md:block md:h-dvh">
		<AppSidebar />
	</aside>

	<header class="sticky top-0 z-40 flex h-12 items-center gap-2 border-b border-border-subtle bg-canvas px-2 md:hidden">
		<button
			type="button"
			class="inline-flex size-11 items-center justify-center rounded-sm text-fg-muted hover:bg-hover hover:text-fg"
			aria-label="Abrir menú"
			aria-expanded={drawerOpen}
			onclick={() => (drawerOpen = true)}
		>
			<Icon name="menu" class="size-5" />
		</button>
		<a href="/dashboard" class="text-md font-medium text-fg">vendeya</a>
	</header>

	{#if drawerOpen}
		<div class="fixed inset-0 z-50 md:hidden">
			<button
				type="button"
				class="absolute inset-0 cursor-default bg-overlay"
				aria-label="Cerrar menú"
				onclick={() => (drawerOpen = false)}
				transition:fade={{ duration: 150 }}
			></button>
			<div
				class="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-popover-border bg-canvas shadow-md"
				role="dialog"
				aria-modal="true"
				aria-label="Menú"
				transition:fly={{ x: -288, duration: 200 }}
			>
				<AppSidebar />
			</div>
		</div>
	{/if}

	<main class="min-w-0 flex-1">
		{@render children()}
	</main>
</div>
