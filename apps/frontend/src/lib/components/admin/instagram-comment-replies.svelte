<script lang="ts">
import { onMount } from "svelte";
import type { CommentReplySettings } from "@vendeya/types";
import { fetchApi } from "#lib/utils/api.js";
import { toast } from "#lib/state/toast.svelte.js";
import Button from "#lib/components/ui/button.svelte";
import FormField from "#lib/components/ui/form-field.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import Textarea from "#lib/components/ui/textarea.svelte";

/** The API's limit on each reply text. */
const MAX_LENGTH = 1000;

let settings = $state<CommentReplySettings | null>(null);
let saving = $state(false);

onMount(async () => {
  try {
    settings = await fetchApi<CommentReplySettings>(
      "/api/admin/instagram/comments",
    );
  } catch (e) {
    console.error(e);
    toast.error("No se pudo cargar la configuración de comentarios");
  }
});

async function save() {
  if (!settings) return;
  saving = true;
  try {
    settings = await fetchApi<CommentReplySettings>(
      "/api/admin/instagram/comments",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      },
    );
    toast.success("Respuestas a comentarios guardadas");
  } catch (e) {
    toast.error("Error al guardar las respuestas a comentarios");
  } finally {
    saving = false;
  }
}
</script>

<form
	onsubmit={(e) => {
		e.preventDefault();
		save();
	}}
>
	<SectionShell
		title="Comentarios de Instagram"
		description="Cuando alguien comenta una publicación, VendeYa le responde una vez bajo el comentario y otra por mensaje directo. En el mensaje directo sigue el asistente. Deja un texto vacío para no enviar esa respuesta."
	>
		{#if !settings}
			<div class="flex flex-col gap-3 p-4" aria-busy="true">
				<div class="h-8 animate-pulse rounded-sm bg-sunken"></div>
				<div class="h-16 animate-pulse rounded-sm bg-sunken"></div>
			</div>
		{:else}
			<div class="flex flex-col gap-2 p-4">
				<label class="flex items-center gap-2 text-base text-fg">
					<input type="checkbox" bind:checked={settings.enabled} class="size-4" />
					Responder a los comentarios
				</label>
				<FormField label="Respuesta pública" for="ig-public">
					<Textarea
						id="ig-public"
						rows={2}
						bind:value={settings.public_text}
						disabled={!settings.enabled}
						error={settings.public_text.length > MAX_LENGTH}
					/>
				</FormField>
				<FormField label="Mensaje directo" for="ig-private">
					<Textarea
						id="ig-private"
						rows={3}
						bind:value={settings.private_text}
						disabled={!settings.enabled}
						error={settings.private_text.length > MAX_LENGTH}
					/>
				</FormField>
			</div>
			<footer class="flex justify-end border-t border-border-subtle px-4 py-3">
				<Button
					type="submit"
					disabled={saving ||
						settings.public_text.length > MAX_LENGTH ||
						settings.private_text.length > MAX_LENGTH}
				>
					{saving ? "Guardando…" : "Guardar"}
				</Button>
			</footer>
		{/if}
	</SectionShell>
</form>
