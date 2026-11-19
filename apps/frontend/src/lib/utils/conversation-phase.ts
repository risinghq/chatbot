// The phases are `ConversationPhase` in packages/core. A conversation stores
// the phase name in `current_state`; a name missing here shows as stored.
const phaseLabels: Record<string, string> = {
  greeting: "Saludo",
  confirming_client: "Confirma si es cliente",
  collecting_dni: "Pide el DNI",
  checking_eligibility: "Verifica el crédito",
  offering_dni_retry: "Reintenta el DNI",
  collecting_age: "Pide la edad",
  offering_products: "Ofrece productos",
  confirming_selection: "Confirma el producto",
  handling_objection: "Responde una objeción",
  closing: "Cierre",
  escalated: "Derivada a una persona",
  waiting_for_recovery: "Espera a un proveedor",
};

export function phaseLabel(state: string): string {
  return phaseLabels[state] ?? state;
}
