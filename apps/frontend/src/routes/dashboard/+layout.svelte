<script lang="ts">
// The chrome belongs to a business or to the platform area. The picker at
// /dashboard has none: until a business is chosen there is nothing to show.
let { children } = $props();
</script>

{@render children()}
