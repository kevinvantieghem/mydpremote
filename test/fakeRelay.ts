// Faux relais Duepi : déchiffre les commandes et répond comme le vrai poêle.
import net from "node:net";
import { checksum, decodeFrame, deriveKey, encodeFrame } from "../src/duepi";

export interface FakeRelay {
  port: number;
  /** Valeur (6 caractères hex) renvoyée par registre. Absent = pas de réponse. */
  registers: Record<string, string>;
  /** Commandes reçues, dans l'ordre. */
  received: string[];
  logins: string[];
  close(): Promise<void>;
}

export async function startFakeRelay(code: string, registers: Record<string, string>): Promise<FakeRelay> {
  const key = deriveKey(code);
  const relay: FakeRelay = { port: 0, registers, received: [], logins: [], close: async () => undefined };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let logged = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!logged) {
        const hash = buffer.indexOf("#");
        if (hash === -1) return;
        relay.logins.push(buffer.subarray(0, hash).toString());
        buffer = buffer.subarray(hash + 1);
        logged = true;
        socket.write("\x1b0000FFFF&"); // bruit en clair juste après la connexion
      }
      let end: number;
      while ((end = buffer.indexOf("&")) !== -1) {
        const frame = buffer.subarray(0, end + 1);
        buffer = buffer.subarray(end + 1);
        const text = decodeFrame(key, frame);
        const command = text.slice(0, 6);
        if (checksum(command) !== text.slice(6, 8)) throw new Error("somme fausse côté client");
        relay.received.push(command);
        const isWrite = command.startsWith("RF") || command === "RD6000";
        const value = isWrite ? "002000" : relay.registers[command];
        if (value === undefined) continue; // registre muet
        // Le vrai relais intercale parfois une trame en clair avant la réponse.
        socket.write(Buffer.concat([Buffer.from("\x1b01020304&"), encodeFrame(key, value)]));
      }
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  relay.port = (server.address() as net.AddressInfo).port;
  relay.close = () =>
    new Promise((ok) => {
      for (const s of sockets) s.destroy();
      server.close(() => ok());
    });
  return relay;
}
