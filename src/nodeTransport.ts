// Connexion TCP avec Node (tests et script de lecture seule, hors Cloudflare).
import net from "node:net";
import { TransportError, type Connector, type Transport } from "./duepi";

export function nodeConnector(host: string, port: number): Connector {
  return () =>
    new Promise<Transport>((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const chunks: Buffer[] = [];
      let closed = false;
      let waiter: (() => void) | null = null;
      const wake = () => {
        waiter?.();
        waiter = null;
      };
      socket.on("data", (c: Buffer) => {
        chunks.push(c);
        wake();
      });
      socket.on("close", () => {
        closed = true;
        wake();
      });
      socket.once("error", () => reject(new TransportError("Connexion au relais Duepi impossible")));
      socket.on("error", () => undefined);
      socket.once("connect", () =>
        resolve({
          write: (bytes) => new Promise((ok, ko) => socket.write(bytes, (e) => (e ? ko(new TransportError("Écriture impossible")) : ok()))),
          async read(timeoutMs) {
            if (!chunks.length && !closed) {
              await new Promise<void>((ok) => {
                const timer = setTimeout(ok, timeoutMs);
                waiter = () => {
                  clearTimeout(timer);
                  ok();
                };
              });
            }
            if (chunks.length) return chunks.shift()!;
            if (closed) throw new TransportError("Le relais a fermé la connexion");
            return null;
          },
          async close() {
            socket.destroy();
          },
        }),
      );
    });
}
