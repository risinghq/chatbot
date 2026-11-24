<script lang="ts">
import { SUPPORT } from "#lib/utils/support.js";

const linkStyles =
  "text-sm text-fg-muted underline-offset-2 transition-colors duration-150 ease-out hover:text-fg hover:underline";
</script>

<footer class="border-t border-border-subtle">
	<div
		class="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:flex-row sm:items-start sm:justify-between md:px-6"
	>
		<div>
			<p class="text-md font-medium text-fg">vendeya</p>
			<p class="mt-1 text-sm text-fg-muted">Un asistente que vende por tu WhatsApp.</p>
		</div>
		<nav aria-label="Pie de página" class="flex flex-col gap-2">
			<a href="/precios" class={linkStyles}>Precios</a>
			<a href="/registro" class={linkStyles}>Crear cuenta gratis</a>
			<a href="/login" class={linkStyles}>Entrar</a>
		</nav>
		<div class="flex flex-col gap-2">
			<a
				href={SUPPORT.whatsappUrl}
				target="_blank"
				rel="noopener noreferrer"
				class={linkStyles}
			>
				WhatsApp {SUPPORT.phoneDisplay}
			</a>
			<a href="mailto:{SUPPORT.email}" class={linkStyles}>{SUPPORT.email}</a>
		</div>
	</div>
</footer>
