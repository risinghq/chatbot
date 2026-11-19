<script lang="ts">
import type { Snippet } from "svelte";

type Props = {
  open: boolean;
  title?: string;
  subtitle?: string;
  onClose: () => void;
  children: Snippet;
  footer?: Snippet;
};

let {
  open = $bindable(),
  title,
  subtitle,
  onClose,
  children,
  footer,
}: Props = $props();
let modalRef: HTMLDivElement | undefined = $state();
let previousActiveElement: Element | null = null;

const modalId = `modal-${Math.random().toString(36).slice(2, 9)}`;
const titleId = $derived(title ? `${modalId}-title` : undefined);

// Focus management and ESC key handler
$effect(() => {
  if (!open) return;

  // Store previous active element
  previousActiveElement = document.activeElement;

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }

    // Basic focus trap
    if (e.key === "Tab" && modalRef) {
      const focusableElements = modalRef.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault();
        lastElement?.focus();
      } else if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault();
        firstElement?.focus();
      }
    }
  };

  document.addEventListener("keydown", handleKeydown);

  return () => {
    document.removeEventListener("keydown", handleKeydown);
    // Return focus to previous element
    if (previousActiveElement && previousActiveElement instanceof HTMLElement) {
      previousActiveElement.focus();
    }
  };
});

// Click outside handler
function handleOverlayClick(e: MouseEvent) {
  if (e.target === e.currentTarget) {
    onClose();
  }
}
</script>

{#if open}
    <div 
        class="fixed inset-0 z-50" 
        onclick={handleOverlayClick}
        role="presentation"
    >
        <div class="absolute inset-0 bg-overlay" aria-hidden="true"></div>

        <div
            bind:this={modalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            class="absolute top-1/2 left-1/2 flex max-h-[90vh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-popover-border bg-surface shadow-md focus-visible:outline-none"
        >
            <div class="flex items-start justify-between gap-4 border-b border-border-subtle px-4 py-3">
                <div class="min-w-0">
                    {#if title}
                        <h2 id={titleId} class="text-md text-fg">{title}</h2>
                    {/if}
                    {#if subtitle}
                        <p class="mt-0.5 text-sm text-fg-muted">{subtitle}</p>
                    {/if}
                </div>
                <button
                    type="button"
                    onclick={onClose}
                    class="-mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-11 touch-manipulation"
                    aria-label="Cerrar"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>
            <div class="flex-1 overflow-y-auto overscroll-contain p-4">
                {@render children()}
            </div>
            {#if footer}
                <div class="flex justify-end gap-2 border-t border-border-subtle px-4 py-3">
                    {@render footer()}
                </div>
            {/if}
        </div>
    </div>
{/if}
