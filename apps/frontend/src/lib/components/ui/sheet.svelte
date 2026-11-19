<script lang="ts">
import { fade, fly } from "svelte/transition";

export let open = false;
export let title = "";
export let description = "";
export let onclose: () => void = () => {};

function close() {
  onclose();
}
</script>

{#if open}
    <div class="fixed inset-0 z-50 overflow-hidden">
        <div
            class="absolute inset-0 cursor-default bg-overlay"
            transition:fade={{ duration: 150 }}
            on:click={close}
            on:keydown={(e) => e.key === "Escape" && close()}
            role="button"
            tabindex="0"
        ></div>

        <div
            class="fixed inset-y-0 right-0 max-w-2xl w-full flex pointer-events-none"
        >
            <div
                class="pointer-events-auto flex h-full w-full flex-col border-l border-popover-border bg-surface shadow-md"
                transition:fly={{ x: 400, duration: 200 }}
            >
                <div
                    class="flex items-center justify-between gap-4 border-b border-border-subtle px-4 py-3"
                >
                    <div>
                        {#if title}
                            <h2 class="text-md text-fg">
                                {title}
                            </h2>
                        {/if}
                        {#if description}
                            <p class="mt-0.5 text-sm text-fg-muted">
                                {description}
                            </p>
                        {/if}
                    </div>
                    <button
                        class="inline-flex size-7 items-center justify-center rounded-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg pointer-coarse:size-11"
                        on:click={close}
                        aria-label="Cerrar"
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            class="size-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M6 18L18 6M6 6l12 12"
                            />
                        </svg>
                    </button>
                </div>

                <div class="flex-1 space-y-4 overflow-y-auto p-4">
                    <slot />
                </div>

                {#if $$slots.footer}
                    <div
                        class="flex justify-end gap-2 border-t border-border-subtle px-4 py-3"
                    >
                        <slot name="footer" />
                    </div>
                {/if}
            </div>
        </div>
    </div>
{/if}
