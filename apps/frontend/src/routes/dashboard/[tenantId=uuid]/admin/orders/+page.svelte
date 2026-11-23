<script lang="ts">
import DeliveryZones from "#lib/components/orders/delivery-zones.svelte";
import PaymentMethods from "#lib/components/orders/payment-methods.svelte";
import type { PageData } from "./$types";

let { data }: { data: PageData } = $props();
</script>

<div class="space-y-6">
	<DeliveryZones zones={data.zones} />
	<PaymentMethods methods={data.methods} />
</div>
