import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  checksum,
  decodeFrame,
  deriveKey,
  encodeFrame,
  parseReply,
  powerCommand,
  setpointCommand,
  value4,
  value6,
} from "../src/duepi";

describe("protocole Duepi", () => {
  it("calcule la somme de contrôle comme le poêle", () => {
    // Exemple connu : ESC R D9000 5F &
    expect(checksum("RD9000")).toBe("5F");
  });

  it("dérive une clé de 16 octets propre à chaque code", () => {
    expect(deriveKey("ABCD1234")).toHaveLength(16);
    expect(deriveKey("ABCD1234").equals(deriveKey("ABCD1235"))).toBe(false);
  });

  it("chiffre puis déchiffre une trame", () => {
    const key = deriveKey("ABCD1234");
    const frame = encodeFrame(key, "RD1000");
    expect(frame[0]).toBe(0x1b);
    expect(frame.at(-1)).toBe(0x26);
    expect(decodeFrame(key, frame)).toBe("RD1000" + checksum("RD1000"));
  });

  it("produit la même trame que la référence Python (IV fixe)", () => {
    const key = deriveKey("TESTCODE");
    const iv = Buffer.alloc(16, 7);
    // Valeur calculée avec l'algorithme de relay.py (Python + cryptography).
    expect(encodeFrame(key, "RD9000", iv).subarray(1, -1).toString("ascii")).toBe("BwcHBwcHBwcHBwcHBwcHB27GXumsfJTVjPSRk3SaNxw=");
  });

  it("refuse une réponse dont la somme est fausse", () => {
    expect(() => parseReply("020100" + "00")).toThrow(ProtocolError);
    expect(parseReply("020100" + checksum("020100"))).toBe("020100");
  });

  it("lit les valeurs", () => {
    expect(value4("00D700")).toBe(215);
    expect(value6("0012AB")).toBe(0x12ab);
  });

  it("encode puissance et consigne", () => {
    expect(powerCommand(1)).toBe("RF0010");
    expect(powerCommand(5)).toBe("RF0050");
    expect(setpointCommand(22)).toBe("RF2160");
    expect(setpointCommand(5)).toBe("RF2050");
    expect(() => powerCommand(6)).toThrow(RangeError);
    expect(() => setpointCommand(41)).toThrow(RangeError);
  });
});
