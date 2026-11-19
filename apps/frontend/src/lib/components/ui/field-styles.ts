// The box every text field shares: input, textarea and the select trigger.
// Text is 16 px below md because iOS zooms into a focused field under 16 px.
export function fieldStyles(error: boolean): string {
  const border = error
    ? "border-danger bg-danger-soft"
    : "border-border hover:border-border-strong focus-visible:border-border-strong";
  return `block w-full rounded-sm border bg-surface px-2.5 text-md text-fg md:text-base placeholder:text-fg-subtle transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:border-border-subtle disabled:bg-sunken disabled:text-fg-muted touch-manipulation ${border}`;
}
