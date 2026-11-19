<script lang="ts">
import { fieldStyles } from "./field-styles";

type Props = {
  id?: string;
  type?: "text" | "number" | "email" | "password" | "date" | "month";
  value?: string | number;
  placeholder?: string;
  disabled?: boolean;
  error?: boolean;
  autocomplete?: string;
  name?: string;
  class?: string;
  oninput?: (e: Event & { currentTarget: HTMLInputElement }) => void;
  onchange?: (e: Event & { currentTarget: HTMLInputElement }) => void;
};

let {
  id,
  type = "text",
  // No fallback: Svelte refuses `bind:value={undefined}` on a prop with one,
  // and forms bind fields of records the API leaves sparse.
  value = $bindable(),
  placeholder,
  disabled = false,
  error = false,
  autocomplete,
  name,
  class: className = "",
  oninput,
  onchange,
}: Props = $props();
</script>

<input
	{id}
	{type}
	{placeholder}
	{disabled}
	name={name}
	autocomplete={autocomplete as any}
	spellcheck={type === "email" || type === "password" ? "false" : undefined}
	bind:value
	{oninput}
	{onchange}
	class="{fieldStyles(error)} h-8 pointer-coarse:h-11 {className}"
/>
