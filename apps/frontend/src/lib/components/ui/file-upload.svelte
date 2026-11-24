<script lang="ts">
import { acceptsFile } from "#lib/utils/accept.js";

type Props = {
  accept?: string;
  file?: File | null;
  error?: boolean;
  placeholder?: string;
  class?: string;
  onchange?: (file: File | null) => void;
};

let {
  accept = "image/*",
  file = $bindable(null),
  error = false,
  placeholder = "Subir archivo",
  class: className = "",
  onchange,
}: Props = $props();

let isDragging = $state(false);

function handleFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const selectedFile = input.files?.[0] || null;
  file = selectedFile;
  onchange?.(selectedFile);
}

function handleDrop(e: DragEvent) {
  e.preventDefault();
  isDragging = false;
  const droppedFile = e.dataTransfer?.files?.[0];
  if (droppedFile && acceptsFile(accept, droppedFile)) {
    file = droppedFile;
    onchange?.(droppedFile);
  }
}

const baseStyles =
  "flex min-h-24 w-full cursor-pointer flex-col items-center justify-center rounded-md border p-4 transition-colors duration-150 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring touch-manipulation";
const normalBorder =
  "border-dashed border-border bg-surface hover:border-border-strong hover:bg-hover";
const errorBorder = "border-dashed border-danger bg-danger-soft";
const activeBorder = "border-solid border-accent bg-accent-soft";
const fileBorder = "border-solid border-border-strong bg-sunken";
</script>

<label
	class="{baseStyles} {error ? errorBorder : file ? fileBorder : isDragging ? activeBorder : normalBorder} {className}"
	ondragover={(e) => { e.preventDefault(); isDragging = true; }}
	ondragleave={() => isDragging = false}
	ondrop={handleDrop}
>
	{#if file}
		<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="mb-2 text-fg">
			<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
			<polyline points="14 2 14 8 20 8"/>
		</svg>
		<span class="max-w-full truncate px-2 text-base font-medium text-fg">{file.name}</span>
		<span class="mt-1 text-sm text-fg-muted">Clic para cambiar</span>
	{:else}
		<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="mb-2 text-fg-muted">
			<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
			<polyline points="17 8 12 3 7 8"/>
			<line x1="12" y1="3" x2="12" y2="15"/>
		</svg>
		<span class="text-base font-medium text-fg-muted">{placeholder}</span>
	{/if}
	<input type="file" {accept} onchange={handleFileChange} class="hidden" />
</label>
