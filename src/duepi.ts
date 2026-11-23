// Protocole du serveur relais Duepi (celui qu'utilise l'app MyDPremote).
//
// Le boîtier Wi-Fi du poêle reste connecté à un relais duepiwebserverN.com.
// Un client qui se présente comme "master" avec le code du boîtier (QR code)
// échange avec lui des trames chiffrées :
//   requête = ESC + base64(IV16 || AES-128-CBC(clé, IV, commande + somme)) + "&"
//   clé     = MD5(code) XOR KEY_MASK
// Référence : github.com/FlorianCasse/DuepiRemoteHA (relay.py).
// Le code du boîtier est un secret : il n'apparaît jamais dans les erreurs.

import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const KEY_MASK = Buffer.from("23FADC18A422678312C86AC29281AC01", "hex");
const ESC = 0x1b;
const AMP = 0x26; // "&"
const BLOCK = 16;
const MAX_FRAME_BYTES = 512;

export const CONNECT_TIMEOUT = 5000;
export const FRAME_TIMEOUT = 4000;
export const LOGIN_DELAY = 500;
const DRAIN_TIMEOUT = 50;

const READ_COMMAND = /^R[CDE][0-9A-F]{4}$/;
const WRITE_COMMAND = /^RF00[0-5]0$|^RF2[0-9A-F]{2}0$|^RD6000$/;
const CLEARTEXT_FRAME = /^\x1b[0-9A-Fa-f]{8}&$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export class DuepiError extends Error {}
/** Le relais ne répond pas ou a coupé la connexion. */
export class TransportError extends DuepiError {}
/** Réponse illisible (mauvais code du boîtier, somme fausse, registre inconnu). */
export class ProtocolError extends DuepiError {}

// ---------- Chiffrement et trames ----------

export function deriveKey(deviceCode: string): Buffer {
  const digest = createHash("md5").update(deviceCode, "utf8").digest();
  return Buffer.from(digest.map((b, i) => b ^ KEY_MASK[i]!));
}

/** Somme des octets modulo 256, en 2 chiffres hexadécimaux majuscules. */
export function checksum(text: string): string {
  let sum = 0;
  for (const byte of Buffer.from(text, "latin1")) sum += byte;
  return (sum & 0xff).toString(16).toUpperCase().padStart(2, "0");
}

export function encodeFrame(key: Buffer, command: string, iv?: Buffer): Buffer {
  if (command.length !== 6) throw new Error("Une commande relais fait 6 caractères");
  const plaintext = Buffer.alloc(BLOCK); // complété par des NUL
  plaintext.write(command + checksum(command), "latin1");
  const vector = iv ?? randomBytes(BLOCK);
  const cipher = createCipheriv("aes-128-cbc", key, vector);
  cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const body = Buffer.from(Buffer.concat([vector, ciphertext]).toString("base64"), "ascii");
  return Buffer.concat([Buffer.from([ESC]), body, Buffer.from([AMP])]);
}

export function decodeFrame(key: Buffer, frame: Buffer): string {
  let start = 0;
  let end = frame.length;
  if (frame[start] === ESC) start++;
  if (frame[end - 1] === AMP) end--;
  const body = frame.subarray(start, end).toString("ascii").trim();
  if (!BASE64.test(body)) throw new ProtocolError("Réponse du relais illisible (base64)");
  const raw = Buffer.from(body, "base64");
  if (raw.length < 2 * BLOCK || raw.length % BLOCK) {
    throw new ProtocolError("Réponse du relais de longueur invalide");
  }
  const decipher = createDecipheriv("aes-128-cbc", key, raw.subarray(0, BLOCK));
  decipher.setAutoPadding(false);
  const plaintext = Buffer.concat([decipher.update(raw.subarray(BLOCK)), decipher.final()]);
  const nul = plaintext.indexOf(0);
  return plaintext.subarray(0, nul === -1 ? plaintext.length : nul).toString("latin1");
}

/** Vérifie la somme d'une réponse (6 caractères de données + 2 de somme) et renvoie les données. */
export function parseReply(plaintext: string): string {
  if (plaintext.length !== 8) throw new ProtocolError("Réponse du relais de taille inattendue");
  const data = plaintext.slice(0, 6);
  if (checksum(data) !== plaintext.slice(6).toUpperCase()) {
    throw new ProtocolError("Somme de contrôle de la réponse fausse");
  }
  if (!/^[0-9A-Fa-f]{6}$/.test(data)) throw new ProtocolError("Réponse non hexadécimale");
  return data;
}

/** Valeur sur 4 chiffres hexadécimaux (la plupart des registres). */
export const value4 = (data: string): number => parseInt(data.slice(0, 4), 16);
/** Valeur sur 6 chiffres hexadécimaux (compteurs d'heures). */
export const value6 = (data: string): number => parseInt(data, 16);

// ---------- Commandes ----------

export const MIN_POWER = 1;
export const MAX_POWER = 5;
export const MIN_TEMPERATURE = 5;
export const MAX_TEMPERATURE = 40;

export function powerCommand(power: number): string {
  if (!Number.isInteger(power) || power < MIN_POWER || power > MAX_POWER) {
    throw new RangeError(`Puissance entre ${MIN_POWER} et ${MAX_POWER}`);
  }
  return `RF00${power}0`;
}

export function setpointCommand(temperature: number): string {
  if (!Number.isInteger(temperature) || temperature < MIN_TEMPERATURE || temperature > MAX_TEMPERATURE) {
    throw new RangeError(`Consigne entre ${MIN_TEMPERATURE} et ${MAX_TEMPERATURE} °C`);
  }
  return `RF2${temperature.toString(16).toUpperCase().padStart(2, "0")}0`;
}

export const OFF_COMMAND = "RF0000";
export const RESET_ALARM_COMMAND = "RD6000";

// ---------- Transport et session ----------

/** Connexion TCP brute, fournie par cloudflare:sockets ou par node:net (tests). */
export interface Transport {
  write(bytes: Uint8Array): Promise<void>;
  /** Renvoie null si rien n'arrive avant le délai ; lève TransportError si la connexion est fermée. */
  read(timeoutMs: number): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

export type Connector = () => Promise<Transport>;

export class Session {
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly transport: Transport,
    private readonly key: Buffer,
  ) {}

  async read(register: string): Promise<string> {
    if (!READ_COMMAND.test(register)) throw new Error(`Lecture non autorisée : ${register}`);
    return parseReply(await this.exchange(register));
  }

  /** Une réponse ne prouve que la livraison de la commande (somme correcte). */
  async write(command: string): Promise<void> {
    if (!WRITE_COMMAND.test(command)) throw new Error(`Écriture non autorisée : ${command}`);
    parseReply(await this.exchange(command));
  }

  private async exchange(command: string): Promise<string> {
    await this.transport.write(encodeFrame(this.key, command));
    return decodeFrame(this.key, await this.readFrame(command));
  }

  /** Renvoie la prochaine trame chiffrée, en ignorant les trames en clair que le relais intercale. */
  private async readFrame(command: string): Promise<Buffer> {
    for (;;) {
      let end = this.buffer.indexOf(AMP);
      while (end !== -1) {
        const start = this.buffer.lastIndexOf(ESC, end);
        if (start === -1) throw new TransportError(`Réponse à ${command} sans début de trame`);
        const frame = this.buffer.subarray(start, end + 1);
        this.buffer = this.buffer.subarray(end + 1);
        if (!CLEARTEXT_FRAME.test(frame.toString("latin1"))) return frame;
        end = this.buffer.indexOf(AMP);
      }
      if (this.buffer.length > MAX_FRAME_BYTES) throw new TransportError(`Réponse à ${command} trop longue`);
      const chunk = await this.transport.read(FRAME_TIMEOUT);
      if (chunk === null) throw new TransportError(`Pas de réponse du poêle à ${command}`);
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }
  }
}

export interface RelayOptions {
  connect: Connector;
  deviceCode: string;
  /** Durée maximale de toute l'opération. */
  timeoutMs?: number;
  loginDelayMs?: number;
}

/** Ouvre une connexion, se connecte comme master, exécute l'opération puis ferme. */
export async function withSession<T>(opts: RelayOptions, operation: (s: Session) => Promise<T>): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let transport: Transport | undefined;
  const run = async (): Promise<T> => {
    transport = await withTimeout(opts.connect(), CONNECT_TIMEOUT, "Connexion au relais Duepi impossible (délai dépassé)");
    await transport.write(Buffer.from(`master:${opts.deviceCode}#`, "utf8"));
    await sleep(opts.loginDelayMs ?? LOGIN_DELAY);
    // Jette ce qui attend déjà, pour qu'une vieille réponse ne soit pas prise pour la bonne.
    while ((await transport.read(DRAIN_TIMEOUT)) !== null) {
      /* vidage */
    }
    return operation(new Session(transport, deriveKey(opts.deviceCode)));
  };
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TransportError("Le poêle met trop de temps à répondre")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await transport?.close().catch(() => undefined);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TransportError(message)), ms);
      }),
    ]);
  } catch (err) {
    if (err instanceof DuepiError) throw err;
    throw new TransportError("Connexion au relais Duepi impossible");
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
