<script lang="ts">
import Button from "#lib/components/ui/button.svelte";

type Props = {
  user?: App.Locals["user"];
};

let { user }: Props = $props();

const linkStyles =
  "inline-flex h-8 items-center rounded-sm px-2.5 text-base text-fg-muted transition-colors duration-150 ease-out hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11";
</script>

<a
  href="#main"
  class="sr-only rounded-sm bg-surface px-3 py-2 text-base text-fg focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10"
>
  Ir al contenido
</a>
<header class="border-b border-border-subtle bg-canvas">
	<div class="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 md:px-6">
		<a href="/" class="text-md font-medium text-fg">vendeya</a>
		<nav aria-label="Principal" class="flex items-center gap-1">
			<a href="/precios" class={linkStyles}>Precios</a>
			{#if user}
				<Button href="/dashboard" size="sm">Ir al panel</Button>
			{:else}
				<a href="/login" class={linkStyles}>Entrar</a>
				<Button href="/registro" size="sm" class="ml-1">Crear cuenta gratis</Button>
			{/if}
		</nav>
	</div>
</header>
