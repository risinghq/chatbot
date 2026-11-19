<script lang="ts">
import FileUpload from "#lib/components/ui/file-upload.svelte";

type Props = {
  hasExistingImage: boolean;
  image: File | null;
  error?: string;
  onImageChange: (file: File | null) => void;
};

let {
  hasExistingImage,
  image = $bindable(null),
  error,
  onImageChange,
}: Props = $props();
</script>

<div class="mb-4">
	<span class="mb-1.5 block text-sm text-fg-muted">
		{hasExistingImage ? "Reemplazar imagen (opcional)" : "Imagen comercial*"}
	</span>
	<FileUpload
		bind:file={image}
		error={!!error}
		placeholder={hasExistingImage ? "Subir nueva imagen…" : "Subir imagen…"}
		onchange={onImageChange}
	/>
	{#if error}
		<p class="mt-1.5 text-sm text-danger-text">{error}</p>
	{/if}
	{#if image}
		<button
			type="button"
			onclick={() => onImageChange(null)}
			class="mt-1.5 text-sm text-fg-muted hover:text-fg hover:underline"
		>
			Cancelar cambio
		</button>
	{/if}
</div>
