// Ce que l'app sait faire avec le poêle, au-dessus du protocole.
//
// Règles de sécurité (une commande de puissance sur un poêle éteint l'allume) :
// - seul turnOn() envoie une puissance à un poêle éteint, et seulement s'il est
//   vraiment éteint et sans erreur ;
// - puissance et consigne ne sont envoyées qu'en chauffe stable (phase 0x0201) ;
// - la consigne ne se relit pas : on garde la dernière envoyée côté serveur.

import {
  OFF_COMMAND,
  ProtocolError,
  RESET_ALARM_COMMAND,
  TransportError,
  powerCommand,
  setpointCommand,
  value4,
  value6,
  withSession,
  type RelayOptions,
  type Session,
} from "./duepi";

export const PHASE_OFF = 0;
export const PHASE_HEATING = 0x0201;

export type Etat = "eteint" | "allumage" | "chauffe" | "nettoyage" | "extinction" | "inconnu";

export function phaseEtat(phase: number): { etat: Etat; label: string } {
  const stage = phase >> 8;
  if (phase === PHASE_OFF) return { etat: "eteint", label: "Éteint" };
  if (phase === PHASE_HEATING) return { etat: "chauffe", label: "En chauffe" };
  if (stage === 0x01) return { etat: "allumage", label: "Allumage" };
  if (phase === 0x0200 || phase === 0x0401) return { etat: "nettoyage", label: "Nettoyage" };
  if (stage === 0x08) return { etat: "extinction", label: "Extinction" };
  return { etat: "inconnu", label: `Phase ${phase.toString(16).padStart(4, "0")}` };
}

export const ERREURS: Record<number, string> = {
  0: "Aucune erreur",
  1: "Échec de l'allumage",
  2: "Défaut d'aspiration",
  3: "Arrivée d'air insuffisante",
  4: "Température de l'eau",
  5: "Plus de pellets",
  6: "Pressostat défectueux",
  7: "Erreur inconnue",
  8: "Coupure de courant",
  9: "Panne du moteur des fumées",
  10: "Surtension de la carte",
  11: "Date expirée",
  12: "Erreur inconnue",
  13: "Erreur du capteur de régulation d'aspiration",
  14: "Surchauffe",
};

export const errorLabel = (code: number) => ERREURS[code] ?? `Erreur ${code}`;

const isHeating = (phase: number, realPower: number) => phase === PHASE_HEATING && realPower >= 1;

/** Registres lus à chaque fois (confirmés par le relais). */
const CORE = {
  phase: "RD9000",
  powerSetting: "RD3000",
  realPower: "RD4000",
  room: "RD1000",
  fumes: "RD0000",
  error: "RDA000",
} as const;

/** 0x0100 = OK, 0x0300 = défaut (aceindy/Duepi_EVO). Autre valeur : pas d'information (ce poêle renvoie toujours 0). */
export const pressureOk = (v: number): boolean | undefined => (v === 0x0100 ? true : v === 0x0300 ? false : undefined);

/** Registres en plus, confirmés seulement en connexion locale : testés, masqués s'ils ne répondent pas. */
export const EXTRAS = {
  pcbTemp: { register: "RDF000", parse: (d: string) => value4(d) },
  fanRpm: { register: "REF000", parse: (d: string) => value4(d) * 10 },
  pressureOk: { register: "RC0000", parse: (d: string) => pressureOk(value4(d)) },
  hoursTotal: { register: "RED000", parse: (d: string) => value6(d) },
  hoursPartial: { register: "REE000", parse: (d: string) => value6(d) },
} as const;
export type ExtraName = keyof typeof EXTRAS;

export interface StoveStatus {
  phase: number;
  etat: Etat;
  etatLabel: string;
  roomTemperature: number;
  fumesTemperature: number;
  powerSetting: number;
  realPower: number;
  errorCode: number;
  errorLabel: string;
  extras: Partial<{ pcbTemp: number; fanRpm: number; pressureOk: boolean; hoursTotal: number; hoursPartial: number }>;
  /** Registres qui n'ont pas répondu cette fois (à masquer). */
  unsupported: ExtraName[];
  readAt: string;
}

export async function readStatus(opts: RelayOptions, skip: readonly ExtraName[] = []): Promise<StoveStatus> {
  return withSession({ timeoutMs: 25000, ...opts }, async (s) => {
    const phase = value4(await s.read(CORE.phase));
    const powerSetting = value4(await s.read(CORE.powerSetting));
    const realPower = value4(await s.read(CORE.realPower));
    const room = value4(await s.read(CORE.room)) / 10;
    const fumes = value4(await s.read(CORE.fumes));
    const errorCode = value4(await s.read(CORE.error));

    const extras: StoveStatus["extras"] = {};
    const unsupported: ExtraName[] = [];
    for (const name of Object.keys(EXTRAS) as ExtraName[]) {
      if (skip.includes(name)) continue;
      try {
        const def = EXTRAS[name];
        const value = def.parse(await s.read(def.register));
        if (value !== undefined) (extras as Record<string, unknown>)[name] = value;
      } catch (err) {
        if (!(err instanceof TransportError || err instanceof ProtocolError)) throw err;
        unsupported.push(name);
        // Après un silence, une réponse tardive pourrait être prise pour la suivante : on s'arrête là.
        if (err instanceof TransportError) break;
      }
    }

    const { etat, label } = phaseEtat(phase);
    return {
      phase,
      etat,
      etatLabel: label,
      roomTemperature: room,
      fumesTemperature: fumes,
      powerSetting,
      realPower,
      errorCode,
      errorLabel: errorLabel(errorCode),
      extras,
      unsupported,
      readAt: new Date().toISOString(),
    };
  });
}

export type TurnOnResult =
  | { result: "allumage" } // la commande d'allumage est partie
  | { result: "deja-en-marche" } // déjà en chauffe : puissance appliquée
  | { result: "deja-en-allumage" }
  | { result: "refuse"; reason: string };

/** Allume un poêle éteint avec la puissance donnée. */
export async function turnOn(opts: RelayOptions, power: number): Promise<TurnOnResult> {
  const command = powerCommand(power);
  return withSession(opts, async (s) => {
    const { phase, realPower, error } = await readCore(s);
    if (isHeating(phase, realPower)) {
      await s.write(command);
      return { result: "deja-en-marche" };
    }
    if (phase === PHASE_OFF) {
      if (error) return { result: "refuse", reason: `Le poêle signale : ${errorLabel(error)}. Réinitialise l'alarme d'abord.` };
      if (realPower) return { result: "refuse", reason: "Le poêle n'est pas complètement arrêté." };
      await s.write(command);
      return { result: "allumage" };
    }
    if (phase >> 8 === 0x01) return { result: "deja-en-allumage" };
    return { result: "refuse", reason: `Le poêle est occupé (${phaseEtat(phase).label}). Réessaie dans quelques minutes.` };
  });
}

export async function turnOff(opts: RelayOptions): Promise<void> {
  await withSession(opts, (s) => s.write(OFF_COMMAND));
}

/** Envoie la puissance si le poêle chauffe. Renvoie false s'il ne chauffe pas (rien n'est envoyé). */
export async function setPower(opts: RelayOptions, power: number): Promise<boolean> {
  const command = powerCommand(power);
  return withSession(opts, async (s) => {
    const { phase, realPower } = await readCore(s);
    if (!isHeating(phase, realPower)) return false;
    await s.write(command);
    return true;
  });
}

/** Envoie la consigne si le poêle chauffe. Renvoie false s'il ne chauffe pas (rien n'est envoyé). */
export async function setSetpoint(opts: RelayOptions, temperature: number): Promise<boolean> {
  const command = setpointCommand(temperature);
  return withSession(opts, async (s) => {
    const { phase, realPower } = await readCore(s);
    if (!isHeating(phase, realPower)) return false;
    await s.write(command);
    return true;
  });
}

/**
 * Mode Auto (le protocole WiFi n'en a pas : on le fait nous-mêmes).
 * Plus la pièce est loin sous la consigne, plus la puissance est forte.
 */
export function autoPower(setpoint: number, room: number): number {
  const gap = setpoint - room;
  if (gap >= 2) return 5;
  if (gap >= 1.5) return 4;
  if (gap >= 1) return 3;
  if (gap >= 0.5) return 2;
  return 1;
}

/** En chauffe stable, règle la puissance selon l'écart à la consigne. Ne fait rien sinon. */
export async function applyAuto(
  opts: RelayOptions,
  setpoint: number,
): Promise<{ heating: false } | { heating: true; room: number; power: number; sent: boolean }> {
  return withSession(opts, async (s) => {
    const { phase, realPower } = await readCore(s);
    if (!isHeating(phase, realPower)) return { heating: false };
    const current = value4(await s.read(CORE.powerSetting));
    const room = value4(await s.read(CORE.room)) / 10;
    const power = autoPower(setpoint, room);
    if (power === current) return { heating: true, room, power, sent: false };
    await s.write(powerCommand(power));
    return { heating: true, room, power, sent: true };
  });
}

export async function resetAlarm(opts: RelayOptions): Promise<void> {
  await withSession(opts, (s) => s.write(RESET_ALARM_COMMAND));
}

async function readCore(s: Session) {
  const phase = value4(await s.read(CORE.phase));
  const realPower = value4(await s.read(CORE.realPower));
  const error = value4(await s.read(CORE.error));
  return { phase, realPower, error };
}
