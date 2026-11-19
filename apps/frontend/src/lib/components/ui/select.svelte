<script lang="ts">
import { fieldStyles } from "./field-styles";

type SelectItem = {
  value: string;
  label: string;
  disabled?: boolean;
};

type Props = {
  id?: string;
  value?: string;
  disabled?: boolean;
  error?: boolean;
  class?: string;
  placeholder?: string;
  items: SelectItem[];
  onchange?: (e: Event & { currentTarget: HTMLSelectElement }) => void;
};

let {
  id,
  // No fallback, as in input.svelte.
  value = $bindable(),
  disabled = false,
  error = false,
  class: className = "",
  placeholder = "Seleccionar...",
  items,
  onchange,
}: Props = $props();

let open = $state(false);
let triggerRef: HTMLButtonElement | undefined = $state();
let selectedIndex = $state(-1);

const selectedLabel = $derived(
  items.find((item) => item.value === value)?.label,
);

function handleSelect(v: string) {
  if (v !== value) {
    value = v;
    if (onchange) {
      const fakeEvent = {
        currentTarget: { value: v } as HTMLSelectElement,
      } as Event & { currentTarget: HTMLSelectElement };
      onchange(fakeEvent);
    }
  }
  open = false;
}

function handleKeydown(e: KeyboardEvent) {
  const availableItems = items.filter((item) => !item.disabled);

  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, availableItems.length - 1);
      break;
    case "ArrowUp":
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      break;
    case "Enter":
      e.preventDefault();
      if (selectedIndex >= 0 && selectedIndex < availableItems.length) {
        const item = availableItems[selectedIndex];
        if (item) {
          handleSelect(item.value);
        }
      }
      break;
  }
}

// ESC key and click outside handler
$effect(() => {
  if (!open) return;

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      open = false;
    }
  };

  const handleClickOutside = (e: MouseEvent) => {
    if (triggerRef && !triggerRef.contains(e.target as Node)) {
      const dropdown = document.querySelector("[data-select-dropdown]");
      if (dropdown && !dropdown.contains(e.target as Node)) {
        open = false;
      }
    }
  };

  document.addEventListener("keydown", handleKeydown);
  document.addEventListener("click", handleClickOutside);

  return () => {
    document.removeEventListener("keydown", handleKeydown);
    document.removeEventListener("click", handleClickOutside);
  };
});
</script>

<div class="relative">
	<button
		bind:this={triggerRef}
		{id}
		type="button"
		{disabled}
		aria-haspopup="listbox"
		aria-expanded={open}
		data-open={open ? "" : undefined}
		onclick={() => !disabled && (open = !open)}
		class="{fieldStyles(error)} flex h-8 cursor-pointer items-center justify-between gap-2 text-left pointer-coarse:h-11 data-[open]:border-border-strong {className}"
	>
		<span class="truncate {selectedLabel ? 'text-fg' : 'text-fg-subtle'}">{selectedLabel || placeholder}</span>
		<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-fg-muted" aria-hidden="true">
			<polyline points="6 9 12 15 18 9"></polyline>
		</svg>
	</button>

	{#if open}
		<div 
			data-select-dropdown
			class="absolute top-full right-0 left-0 z-100 mt-1 max-h-75 overflow-auto rounded-lg border border-popover-border bg-surface p-1 shadow-md"
			onkeydown={handleKeydown}
			role="listbox"
			tabindex="-1"
		>
			{#each items as { value: itemValue, label, disabled: itemDisabled }, i (itemValue)}
				<button
					type="button"
					disabled={itemDisabled}
					onclick={() => !itemDisabled && handleSelect(itemValue)}
					class="flex h-8 w-full cursor-pointer items-center rounded-sm px-2 text-left text-base text-fg transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-11 touch-manipulation {selectedIndex === i ? 'bg-hover' : ''}"
					role="option"
					aria-selected={value === itemValue}
					tabindex={itemDisabled ? -1 : 0}
				>
					<span class="flex items-center gap-2">
						<span class="flex w-4 items-center justify-center text-accent-text">
							{#if value === itemValue}✓{/if}
						</span>
						<span class:font-medium={value === itemValue}>{label}</span>
					</span>
				</button>
			{/each}
		</div>
	{/if}
</div>
