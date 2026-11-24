<script lang="ts">
import type { HistoryEntry } from "@vendeya/types";
import Badge from "#lib/components/ui/badge.svelte";
import { byDay, phrase, type HistoryPlace } from "#lib/utils/history.js";
import { formatTime } from "#lib/utils/formatters.js";

let {
  entries,
  place,
  now = Date.now(),
}: { entries: HistoryEntry[]; place: HistoryPlace; now?: number } = $props();

const days = $derived(byDay(entries, now));
</script>

<div class="flex flex-col gap-6">
	{#each days as day (day.key)}
		<section>
			<h2 class="mb-2 text-sm text-fg-muted">{day.title}</h2>
			<ol class="divide-y divide-border-subtle rounded-md border border-border bg-surface">
				{#each day.entries as entry (entry.id)}
					{@const p = phrase(entry, place)}
					<li class="flex gap-4 px-4 py-3">
						<time
							class="w-20 shrink-0 pt-px text-sm text-fg-muted tabular-nums"
							datetime={new Date(entry.at).toISOString()}
						>
							{formatTime(entry.at)}
						</time>
						<div class="min-w-0 flex-1">
							<p class="text-base text-pretty text-fg-muted">
								<span class="font-medium text-fg">{p.actor}</span>
								{p.verb}
								{#if p.subject}
									{#if p.subject.href}
										<a href={p.subject.href} class="text-fg underline decoration-border underline-offset-2 hover:decoration-fg">{p.subject.label}</a>
									{:else}
										<span class="text-fg">{p.subject.label}</span>
									{/if}
								{/if}
								{p.tail}
								{#if p.unconfirmed}
									<Badge variant="warning" class="ml-1 align-middle">Entrega sin confirmar</Badge>
								{/if}
							</p>
							{#if p.quote}
								<p class="mt-1 line-clamp-2 text-sm text-fg-muted">«{p.quote}»</p>
							{/if}
						</div>
					</li>
				{/each}
			</ol>
		</section>
	{/each}
</div>
