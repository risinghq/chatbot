<script lang="ts">
import { DOCUMENT_TYPES } from "@vendeya/types";
import FormField from "#lib/components/ui/form-field.svelte";
import Input from "#lib/components/ui/input.svelte";
import Select from "#lib/components/ui/select.svelte";
import Textarea from "#lib/components/ui/textarea.svelte";
import {
  type CustomerForm,
  documentTypeLabels,
} from "#lib/utils/customer-form.js";

type Props = {
  form: CustomerForm;
  errors: Partial<Record<keyof CustomerForm, string>>;
  disabled?: boolean;
};

let { form = $bindable(), errors, disabled = false }: Props = $props();

const documentItems = [
  { value: "", label: "Sin documento" },
  ...DOCUMENT_TYPES.map((type) => ({
    value: type,
    label: documentTypeLabels[type],
  })),
];
</script>

<FormField label="Nombre*" for="customer-name" error={errors.name}>
	<Input id="customer-name" bind:value={form.name} {disabled} autocomplete="off" />
</FormField>
<div class="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
	<FormField label="Teléfono" for="customer-phone" error={errors.phone}>
		<Input id="customer-phone" bind:value={form.phone} {disabled} inputmode="numeric" placeholder="51 999 888 777" class="font-mono" />
	</FormField>
	<FormField label="Correo" for="customer-email" error={errors.email}>
		<Input id="customer-email" type="email" bind:value={form.email} {disabled} />
	</FormField>
	<FormField label="Documento" for="customer-document-type" error={errors.documentType}>
		<Select id="customer-document-type" bind:value={form.documentType} items={documentItems} {disabled} />
	</FormField>
	<FormField label="Número de documento" for="customer-document-number" error={errors.documentNumber}>
		<Input id="customer-document-number" bind:value={form.documentNumber} {disabled} class="font-mono" />
	</FormField>
</div>
<FormField label="Notas" for="customer-notes">
	<Textarea id="customer-notes" bind:value={form.notes} rows={2} {disabled} placeholder="Ej. Prefiere entregas por la tarde" />
</FormField>
