/**
 * Typed message routing over a (re-attachable) Link. Each incoming message is
 * stamped with the local clock the moment it arrives, before parsing, so the
 * clock-sync responder can use the earliest possible receive time.
 */
import type { Link } from './link';
import { Emitter } from './link';
import type { Clock } from './time';

type Msg = { t: string };
type Handler<M> = (msg: M, receivedAt: number) => void;

export class Bus<In extends Msg, Out extends Msg> {
  private link: Link | null = null;
  private unbind: (() => void)[] = [];
  private readonly handlers = new Map<string, Set<Handler<In>>>();
  readonly binary = new Emitter<[ArrayBuffer]>();
  readonly closed = new Emitter<[Link]>();
  readonly invalid = new Emitter<[string]>();

  constructor(
    private readonly parse: (text: string) => In | null,
    private readonly clock: Clock,
  ) {}

  get current(): Link | null {
    return this.link;
  }

  get isOpen(): boolean {
    return !!this.link && this.link.isOpen();
  }

  attach(link: Link): void {
    this.detach();
    this.link = link;
    this.unbind.push(
      link.onMessage((data) => {
        const receivedAt = this.clock();
        if (typeof data === 'string') {
          const msg = this.parse(data);
          if (!msg) {
            this.invalid.emit(data.slice(0, 120));
            return;
          }
          this.dispatch(msg, receivedAt);
        } else {
          this.binary.emit(data);
        }
      }),
      link.onClose(() => {
        if (this.link === link) {
          this.detach();
          this.closed.emit(link);
        }
      }),
    );
  }

  detach(): void {
    for (const u of this.unbind) u();
    this.unbind = [];
    this.link = null;
  }

  /** Returns false if there is no open link (the message is dropped). */
  send(msg: Out): boolean {
    const link = this.link;
    if (!link || !link.isOpen()) return false;
    try {
      link.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  sendBinary(buf: ArrayBuffer): void {
    const link = this.link;
    if (!link || !link.isOpen()) throw new Error('link not open');
    link.send(buf);
  }

  bufferedAmount(): number {
    return this.link?.bufferedAmount() ?? 0;
  }

  on<T extends In['t']>(type: T, handler: Handler<Extract<In, { t: T }>>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler as Handler<In>);
    return () => set!.delete(handler as Handler<In>);
  }

  private dispatch(msg: In, receivedAt: number): void {
    const set = this.handlers.get(msg.t);
    if (!set) return;
    for (const h of [...set]) {
      try {
        h(msg, receivedAt);
      } catch (err) {
        console.error('handler failed for', msg.t, err);
      }
    }
  }
}
