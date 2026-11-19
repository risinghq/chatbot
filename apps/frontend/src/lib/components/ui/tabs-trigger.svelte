<script lang="ts">
import { getContext } from "svelte";

type Props = {
  value: string;
  children: any;
};

let { value, children }: Props = $props();

const tabs = getContext<{
  getValue: () => string;
  setValue: (v: string) => void;
}>("tabs");

let isSelected = $derived(tabs.getValue() === value);
</script>

<button
  class="-mb-px h-9 border-b-2 px-3 text-base font-medium transition-colors {isSelected
    ? 'border-fg text-fg'
    : 'border-transparent text-fg-muted hover:text-fg'}"
  onclick={() => tabs.setValue(value)}
>
  {@render children()}
</button>
