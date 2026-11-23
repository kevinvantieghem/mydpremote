// Plages horaires façon Chacon : début, fin, jours cochés, interrupteur.
// Le cron tourne chaque minute ; chaque début (allumer) et chaque fin (éteindre)
// ne se déclenche qu'une fois par jour, avec un rattrapage de quelques minutes
// si une exécution du cron a sauté ou si le poêle n'a pas répondu.

export const TIME_ZONE = "Europe/Paris";
export const CATCH_UP_MINUTES = 5;

export interface Plage {
  id: string;
  nom: string;
  /** "HH:MM" */
  debut: string;
  /** "HH:MM". Si elle est avant le début, la plage finit le lendemain. */
  fin: string;
  /** 7 cases, lundi en premier. Ce sont les jours où la plage commence. */
  jours: boolean[];
  actif: boolean;
}

export interface Action {
  key: string;
  plageId: string;
  action: "on" | "off";
  /** Minute exacte prévue (pour l'ordre). */
  at: number;
}

export const DEFAULT_PLAGES: Plage[] = [
  { id: "matin", nom: "Matin", debut: "06:30", fin: "08:30", jours: Array(7).fill(true), actif: false },
  { id: "soir", nom: "Soir", debut: "17:30", fin: "22:00", jours: Array(7).fill(true), actif: false },
  { id: "extra", nom: "Au cas où", debut: "12:00", fin: "14:00", jours: Array(7).fill(false), actif: false },
];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const toMinutes = (hhmm: string) => {
  const m = HHMM.exec(hhmm);
  if (!m) throw new RangeError(`Heure invalide : ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/** Vérifie et nettoie des plages reçues de l'app. Lève RangeError si quelque chose ne va pas. */
export function validatePlages(input: unknown): Plage[] {
  if (!Array.isArray(input) || input.length > 20) throw new RangeError("Liste de plages invalide");
  const ids = new Set<string>();
  return input.map((p: any, i) => {
    const id = String(p?.id ?? "");
    if (!/^[a-z0-9-]{1,40}$/i.test(id) || ids.has(id)) throw new RangeError(`Plage ${i + 1} : identifiant invalide`);
    ids.add(id);
    const debut = String(p.debut);
    const fin = String(p.fin);
    toMinutes(debut);
    toMinutes(fin);
    if (debut === fin) throw new RangeError(`Plage « ${p.nom} » : le début et la fin sont identiques`);
    if (!Array.isArray(p.jours) || p.jours.length !== 7) throw new RangeError(`Plage ${i + 1} : jours invalides`);
    return {
      id,
      nom: String(p.nom ?? "").slice(0, 30) || `Plage ${i + 1}`,
      debut,
      fin,
      jours: p.jours.map(Boolean),
      actif: Boolean(p.actif),
    };
  });
}

export interface LocalTime {
  /** 0 = lundi … 6 = dimanche */
  day: number;
  minutes: number;
  /** "AAAA-MM-JJ" à Paris */
  date: string;
}

const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function parisTime(date: Date): LocalTime {
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    day: WEEKDAYS.indexOf(parts.weekday!),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/**
 * Actions à exécuter maintenant, dans l'ordre chronologique.
 * `fired` contient les clés déjà exécutées.
 */
export function dueActions(
  plages: Plage[],
  now: Date,
  fired: Record<string, unknown>,
  catchUpMinutes = CATCH_UP_MINUTES,
): Action[] {
  const actions: Action[] = [];
  const base = Math.floor(now.getTime() / 60000);
  for (let k = catchUpMinutes - 1; k >= 0; k--) {
    const minute = base - k;
    const t = parisTime(new Date(minute * 60000));
    for (const p of plages) {
      if (!p.actif) continue;
      const start = toMinutes(p.debut);
      const end = toMinutes(p.fin);
      if (t.minutes === start && p.jours[t.day]) {
        actions.push({ key: `${p.id}:on:${t.date}`, plageId: p.id, action: "on", at: minute });
      }
      // Une plage qui passe minuit finit le lendemain d'un jour coché.
      const startDay = end < start ? (t.day + 6) % 7 : t.day;
      if (t.minutes === end && p.jours[startDay]) {
        actions.push({ key: `${p.id}:off:${t.date}`, plageId: p.id, action: "off", at: minute });
      }
    }
  }
  return actions.filter((a) => !(a.key in fired));
}

/** Choisit l'action à exécuter quand plusieurs se cumulent : la plus récente, et "on" gagne à égalité. */
export function finalAction(actions: Action[]): Action | undefined {
  return [...actions].sort((a, b) => a.at - b.at || (a.action === b.action ? 0 : a.action === "off" ? -1 : 1)).at(-1);
}

/** Vrai si une autre plage active est en cours à cet instant (pour ne pas éteindre au milieu d'elle). */
export function insideOtherPlage(plages: Plage[], now: Date, excludeId: string): boolean {
  const t = parisTime(now);
  return plages.some((p) => {
    if (!p.actif || p.id === excludeId) return false;
    const start = toMinutes(p.debut);
    const end = toMinutes(p.fin);
    if (start < end) return p.jours[t.day]! && t.minutes >= start && t.minutes < end;
    // Passe minuit : soit le soir d'un jour coché, soit le matin qui suit.
    return (p.jours[t.day]! && t.minutes >= start) || (p.jours[(t.day + 6) % 7]! && t.minutes < end);
  });
}

/** Garde seulement les clés récentes (moins de 3 jours). */
export function pruneFired(fired: Record<string, string>, now: Date): Record<string, string> {
  const limit = now.getTime() - 3 * 24 * 3600 * 1000;
  return Object.fromEntries(Object.entries(fired).filter(([, at]) => Date.parse(at) >= limit));
}
