<script lang="ts">
import { getContext } from "svelte";

type Props = {
  value: string;
  children: any;
};

let { value, children }: Props = $props();

const tabs = getContext<{ getValue: () => string }>("tabs");
</script>

{#if tabs.getValue() === value}
  <div class="mt-2">
    {@render children()}
  </div>
{/if}
