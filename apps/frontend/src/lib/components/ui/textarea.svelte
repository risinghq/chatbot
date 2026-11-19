<script lang="ts">
import { fieldStyles } from "./field-styles";

type Props = {
  id?: string;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  error?: boolean;
  rows?: number;
  name?: string;
  autocomplete?: string;
  class?: string;
  oninput?: (e: Event & { currentTarget: HTMLTextAreaElement }) => void;
};

let {
  id,
  // No fallback, as in input.svelte.
  value = $bindable(),
  placeholder,
  disabled = false,
  error = false,
  rows = 3,
  name,
  autocomplete,
  class: className = "",
  oninput,
}: Props = $props();
</script>

<textarea
	{id}
	{placeholder}
	{disabled}
	{rows}
	name={name}
	autocomplete={autocomplete as any}
	bind:value
	{oninput}
	class="{fieldStyles(error)} resize-y py-1.5 {className}"
></textarea>
