import type { Customer, DocumentType } from "@vendeya/types";

export const documentTypeLabels: Record<DocumentType, string> = {
  dni: "DNI",
  ce: "Carné de extranjería",
  ruc: "RUC",
  passport: "Pasaporte",
};

/** The customer form's fields, all text so inputs can bind them. */
export type CustomerForm = {
  name: string;
  phone: string;
  email: string;
  /** A `DocumentType`, or empty for none. */
  documentType: string;
  documentNumber: string;
  notes: string;
};

export function customerForm(customer?: Customer): CustomerForm {
  return {
    name: customer?.name ?? "",
    phone: customer?.phone ?? "",
    email: customer?.email ?? "",
    documentType: customer?.document_type ?? "",
    documentNumber: customer?.document_number ?? "",
    notes: customer?.notes ?? "",
  };
}

/** What is wrong with the form, by field. Empty when it can be sent. */
export function customerFormProblems(
  form: CustomerForm,
): Partial<Record<keyof CustomerForm, string>> {
  const problems: Partial<Record<keyof CustomerForm, string>> = {};
  if (!form.name.trim()) problems.name = "El nombre es obligatorio";
  const phone = form.phone.replace(/[\s\-()+.]/g, "");
  if (phone && !/^\d{6,15}$/.test(phone))
    problems.phone = "Escribe un número de 6 a 15 dígitos, ej. 999 888 777";
  if (form.documentType && !form.documentNumber.trim())
    problems.documentNumber = "Escribe el número del documento";
  if (!form.documentType && form.documentNumber.trim())
    problems.documentType = "Elige el tipo de documento";
  return problems;
}

/** The request body for a create or update. An empty field clears it. */
export function customerBody(form: CustomerForm) {
  return {
    name: form.name.trim(),
    phone: form.phone.trim() || null,
    email: form.email.trim() || null,
    document_type: (form.documentType || null) as DocumentType | null,
    document_number: form.documentNumber.trim() || null,
    notes: form.notes.trim() || null,
  };
}
