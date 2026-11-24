<script lang="ts">
type Props = {
  src: string;
  alt: string;
};

let { src, alt }: Props = $props();
</script>

<figure class="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
	<img {src} {alt} width="1600" height="1000" class="block h-auto w-full" decoding="async" />
</figure>
