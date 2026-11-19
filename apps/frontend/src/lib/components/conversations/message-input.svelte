<script lang="ts">
import Button from "#lib/components/ui/button.svelte";
import { fieldStyles } from "#lib/components/ui/field-styles.js";

type Props = {
  value: string;
  disabled?: boolean;
  onSend: () => void;
};

let { value = $bindable(""), disabled = false, onSend }: Props = $props();

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    onSend();
  }
}
</script>

<div class="border-t border-border-subtle bg-surface p-3">
	<div class="flex items-center gap-2">
		<input
			bind:value
			{disabled}
			onkeydown={handleKeydown}
			aria-label="Mensaje"
			class="{fieldStyles(false)} h-9 pointer-coarse:h-11"
			placeholder="Escribe un mensaje…"
		/>
		<Button onclick={onSend} disabled={disabled || !value.trim()}>Enviar</Button>
	</div>
	<p class="mt-1.5 hidden text-xs text-fg-muted md:block">Enter envía.</p>
</div>
