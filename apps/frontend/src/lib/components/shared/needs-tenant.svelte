<script lang="ts">
import { auth } from "#lib/state/auth.svelte.js";
</script>

<div class="border border-ink-100 bg-cream-50 p-8 text-center">
  <p class="font-serif text-xl text-ink-900 mb-2">
    No hay un negocio seleccionado
  </p>
  <p class="text-sm text-ink-500 mb-6">
    Esta página trabaja dentro de un negocio. Elige uno para continuar.
  </p>
  {#if auth.isPlatformOperator}
    <a
      href="/dashboard/negocios"
      class="inline-block px-4 py-2 bg-ink-900 text-cream-50 text-xs font-bold uppercase tracking-widest hover:bg-ink-700 transition-colors"
    >
      Ir a Negocios
    </a>
  {/if}
</div>
