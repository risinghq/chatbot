import { setupEventSubscribers } from "./event-bus-setup.ts";

let initialized = false;

/** Wires the event subscribers once per isolate. */
export function initializeApplication(): void {
  if (initialized) return;
  initialized = true;

  setupEventSubscribers();
}
