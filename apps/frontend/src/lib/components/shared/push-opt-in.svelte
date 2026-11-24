<script lang="ts">
import { onMount } from "svelte";
import Button from "#lib/components/ui/button.svelte";
import SectionShell from "#lib/components/ui/section-shell.svelte";
import { toast } from "#lib/state/toast.svelte.js";
import { fetchApi } from "#lib/utils/api.js";

type PushState =
  | "loading"
  | "unsupported"
  | "denied"
  | "subscribed"
  | "unsubscribed";

let pushState: PushState = $state("loading");
let busy = $state(false);

const descriptions: Record<PushState, string> = {
  loading: "Comprobando este navegador…",
  unsupported:
    "Este navegador no admite notificaciones. En iPhone instala VendeYa desde Compartir → Añadir a pantalla de inicio.",
  denied:
    "El navegador tiene las notificaciones bloqueadas para este sitio. Actívalas en sus ajustes y vuelve.",
  subscribed: "Este teléfono recibe avisos de este negocio.",
  unsubscribed:
    "Te avisamos cuando un cliente necesita atención o llega un pedido nuevo.",
};

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

onMount(async () => {
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    pushState = "unsupported";
    return;
  }
  if (Notification.permission === "denied") {
    pushState = "denied";
    return;
  }
  const registration = await navigator.serviceWorker.ready;
  pushState = (await registration.pushManager.getSubscription())
    ? "subscribed"
    : "unsubscribed";
});

async function enable() {
  busy = true;
  try {
    const { publicKey } = await fetchApi<{ publicKey: string | null }>(
      "/api/push/vapid-public-key",
    );
    if (!publicKey) {
      toast.error(
        "Las notificaciones aún no están configuradas en el servidor",
      );
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(
        publicKey,
      ) as unknown as BufferSource,
    });
    await fetchApi("/api/push/subscription", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription.toJSON()),
    });
    pushState = "subscribed";
    toast.success("Notificaciones activadas en este teléfono");
  } catch {
    if (Notification.permission === "denied") {
      pushState = "denied";
    } else {
      toast.error("No se pudieron activar las notificaciones");
    }
  } finally {
    busy = false;
  }
}

async function disable() {
  busy = true;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await fetchApi("/api/push/subscription", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      await subscription.unsubscribe();
    }
    pushState = "unsubscribed";
    toast.success("Notificaciones desactivadas");
  } catch {
    toast.error("No se pudieron desactivar las notificaciones");
  } finally {
    busy = false;
  }
}
</script>

<SectionShell
	title="Notificaciones en este teléfono"
	description={descriptions[pushState]}
>
	<div class="flex items-center justify-end gap-3 p-4">
		{#if pushState === "subscribed"}
			<Button variant="secondary" size="sm" disabled={busy} onclick={disable}>
				{busy ? "Desactivando…" : "Desactivar"}
			</Button>
		{:else if pushState === "unsubscribed"}
			<Button size="sm" disabled={busy} onclick={enable}>
				{busy ? "Activando…" : "Activar"}
			</Button>
		{/if}
	</div>
</SectionShell>
