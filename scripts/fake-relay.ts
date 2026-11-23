// Lance un faux relais Duepi sur le port 3999 pour tester l'app sans le vrai poêle.
// Usage : npx tsx scripts/fake-relay.ts
import net from "node:net";
import { checksum, decodeFrame, deriveKey, encodeFrame } from "../src/duepi";

const CODE = "TESTCODE";
const key = deriveKey(CODE);
const regs: Record<string, string> = {
  RD9000: "000000", RD3000: "000300", RD4000: "000000", RD1000: "00C300", RD0000: "001900", RDA000: "000000",
  RDF000: "002000", REF000: "000000", RC0000: "010000", RED000: "000ABC", REE000: "000012",
};
net.createServer((socket) => {
  let buf = Buffer.alloc(0);
  let logged = false;
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (!logged) {
      const i = buf.indexOf("#");
      if (i === -1) return;
      console.log("login", buf.subarray(0, i).toString().replace(CODE, "<code>"));
      buf = buf.subarray(i + 1);
      logged = true;
    }
    let end: number;
    while ((end = buf.indexOf("&")) !== -1) {
      const text = decodeFrame(key, buf.subarray(0, end + 1));
      buf = buf.subarray(end + 1);
      const cmd = text.slice(0, 6);
      if (checksum(cmd) !== text.slice(6, 8)) { console.log("somme fausse"); continue; }
      if (cmd.startsWith("RF") || cmd === "RD6000") {
        console.log("ÉCRITURE", cmd);
        if (cmd === "RF0000") { regs.RD9000 = "000000"; regs.RD4000 = "000000"; }
        else if (cmd.startsWith("RF00")) { regs.RD9000 = "020100"; regs.RD4000 = `000${cmd[4]}00`; regs.RD3000 = `000${cmd[4]}00`; regs.REF000 = "009600"; }
        socket.write(encodeFrame(key, "002000"));
        continue;
      }
      const v = regs[cmd];
      if (v) socket.write(encodeFrame(key, v));
    }
  });
  socket.on("error", () => undefined);
}).listen(3999, "127.0.0.1", () => console.log("faux relais prêt sur 3999"));
