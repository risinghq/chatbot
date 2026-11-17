import { waitUntil } from "cloudflare:workers";
import type { DomainEvent } from "./types.ts";
import type { EventBus } from "./event-bus.ts";

export class AsyncEventEmitter {
  constructor(private eventBus: EventBus) {}

  async emitCritical(event: DomainEvent): Promise<void> {
    await this.eventBus.emit(event);
  }

  emitAsync(event: DomainEvent): void {
    // The bus logs handler failures. `waitUntil` keeps the request alive until
    // the handlers end, after the response is sent.
    waitUntil(Promise.resolve().then(() => this.eventBus.emit(event)));
  }
}
