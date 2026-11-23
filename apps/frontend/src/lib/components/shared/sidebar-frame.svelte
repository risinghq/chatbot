<script lang="ts" module>
import type { IconName } from "#lib/components/ui/icon.svelte";

export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  /** The path prefix the item stays highlighted under, when not `href`. */
  match?: string;
  /** Highlight only on `href` itself, not on the pages below it. */
  exact?: boolean;
};
export type NavSection = { title: string | null; items: NavItem[] };
</script>

<script lang="ts">
import type { Snippet } from "svelte";
import { page } from "$app/state";
import Icon from "#lib/components/ui/icon.svelte";
import { auth } from "#lib/state/auth.svelte.js";
import { roleLabel } from "#lib/utils/roles.js";

let {
  home,
  sections,
  account,
  scope,
}: {
  home: string;
  sections: NavSection[];
  /** The account page, when the area has one. */
  account?: string;
  /** What the sidebar acts on: the business switcher or the area's name. */
  scope: Snippet;
} = $props();

function isActive(item: NavItem): boolean {
  const path = page.url.pathname;
  if (item.exact) return path === item.href;
  const base = item.match ?? item.href;
  return path === base || path.startsWith(`${base}/`);
}

const visible = $derived(sections.filter((s) => s.items.length > 0));
</script>

<div class="flex h-full flex-col gap-4 p-3">
	<a href={home} class="flex h-8 items-center px-2 text-md font-medium text-fg">vendeya</a>

	{@render scope()}

	<nav class="flex flex-1 flex-col gap-4 overflow-y-auto" aria-label="Principal">
		{#each visible as section (section.title)}
			<div>
				{#if section.title}
					<p class="mb-1 px-2 text-xs text-fg-muted">{section.title}</p>
				{/if}
				<ul class="flex flex-col gap-px">
					{#each section.items as item (item.href)}
						{@const active = isActive(item)}
						<li>
							<a
								href={item.href}
								aria-current={active ? "page" : undefined}
								class="flex h-8 items-center gap-2.5 rounded-sm px-2 text-base transition-colors duration-150 ease-out pointer-coarse:h-11 {active
									? 'bg-sunken-strong text-fg'
									: 'text-fg-muted hover:bg-hover hover:text-fg'}"
							>
								<Icon name={item.icon} />
								{item.label}
							</a>
						</li>
					{/each}
				</ul>
			</div>
		{/each}
	</nav>

	<div class="flex flex-col gap-2 border-t border-border-subtle pt-3">
		{#if auth.isSalesAgent}
			<button
				type="button"
				role="switch"
				aria-checked={auth.isAvailable}
				onclick={() => auth.toggleAvailability()}
				class="flex h-8 items-center gap-2.5 rounded-sm px-2 text-base text-fg transition-colors hover:bg-hover pointer-coarse:h-11"
			>
				<span class="size-2 rounded-full {auth.isAvailable ? 'bg-success' : 'bg-fg-subtle'}"></span>
				{auth.isAvailable ? "Disponible" : "No disponible"}
			</button>
		{/if}
		<div class="flex items-center gap-2 px-2">
			<svelte:element
				this={account ? "a" : "div"}
				href={account}
				title={account ? "Mi cuenta" : undefined}
				class="-mx-1 min-w-0 flex-1 rounded-sm px-1 py-0.5 {account ? 'transition-colors hover:bg-hover' : ''}"
			>
				<p class="truncate text-base text-fg">{auth.user?.name || auth.user?.email}</p>
				<p class="truncate text-xs text-fg-muted">
					{auth.isPlatformOperator ? "Operador de plataforma" : roleLabel(auth.user?.role)}
				</p>
			</svelte:element>
			<button
				type="button"
				onclick={() => auth.logout()}
				class="inline-flex size-8 items-center justify-center rounded-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg pointer-coarse:size-11"
				aria-label="Salir"
				title="Salir"
			>
				<Icon name="logout" />
			</button>
		</div>
	</div>
</div>
