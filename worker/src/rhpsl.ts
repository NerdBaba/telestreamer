/**
 * RHPSL (live.rhpsl.com) horse racing source.
 *
 * Unlike RWITC, whose HLS gate is an Origin header on a signing Lambda, RHPSL
 * gates video behind a purchased subscription: POST /playback/sessions returns
 * UNAUTHORIZED without a customer bearer token, and the venue page checks
 * subscription.subscribed before it will even request a session. There is no
 * anonymous preview path.
 *
 * Consequences baked into this module:
 *   - Public race data (racecard, schedule) IS available without credentials,
 *     so it works today for every venue.
 *   - Live media is only ever claimed when a verifiable session plus a recent
 *     media timestamp establish it. Missing credentials produce an honest
 *     "credential required" status instead of a faked stream.
 */

const API = 'https://node.rhpsl.com/api/api/v1';

export interface RhpslRunner {
  number: number;
  horseName: string;
  jockey?: string;
  trainer?: string;
  weight?: string;
  draw?: number;
  rating?: string;
  silkImage?: string;
  description?: string;
}

export interface RhpslRace {
  number: number;
  name: string;
  time: string;
  distance?: string;
  runners: RhpslRunner[];
}

export interface RhpslRaceCard {
  raceDate: string;
  venueName: string;
  venueCode: string;
  races: RhpslRace[];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function integer(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isInteger(parsed) ? parsed : undefined;
}

/** Normalize a racecard payload; unusable data is never turned into media. */
export function parseRaceCard(payload: unknown): RhpslRaceCard | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as Record<string, unknown>;
  if (body.success !== true) return null;
  const data = body.data as Record<string, unknown> | undefined;
  if (!data || data.available !== true) return null;
  const card = data.raceCard as Record<string, unknown> | undefined;
  const rawRaces = card?.races;
  if (!card || !Array.isArray(rawRaces)) return null;
  const races: RhpslRace[] = [];
  for (const raw of rawRaces) {
    if (!raw || typeof raw !== 'object') continue;
    const race = raw as Record<string, unknown>;
    const number = integer(race.raceNumber);
    const rawRunners = race.runners;
    if (number === undefined || !Array.isArray(rawRunners)) continue;
    const runners: RhpslRunner[] = [];
    for (const rawRunner of rawRunners) {
      if (!rawRunner || typeof rawRunner !== 'object') continue;
      const runner = rawRunner as Record<string, unknown>;
      const horseName = text(runner.horseName);
      const runnerNumber = integer(runner.number);
      if (!horseName || runnerNumber === undefined) continue;
      runners.push({
        number: runnerNumber,
        horseName,
        jockey: text(runner.jockey),
        trainer: text(runner.trainer),
        weight: text(runner.weight),
        draw: integer(runner.draw),
        rating: text(runner.rating),
        silkImage: text(runner.silkUrl),
        description: text(runner.description),
      });
    }
    races.push({
      number,
      name: text(race.raceName) || 'Race',
      time: text(race.startTime) || '',
      distance: text(race.distance),
      runners,
    });
  }
  if (!races.length) return null;
  const venueCode = text(card.venueCode);
  const venueName = text(card.venueName) || venueCode;
  if (!venueCode || !venueName || !text(card.date)) return null;
  return { raceDate: text(card.date)!, venueName, venueCode, races };
}

export interface RhpslSession {
  playbackUrl: string;
  credentialed: boolean;
}

export interface RhpslHooks {
  openSession?: (slug: string, token: string | undefined) => Promise<RhpslSession | null>;
  mediaLag?: (playlistUrl: string) => Promise<number | null>;
}

export interface RhpslStatus {
  available: boolean;
  credentialRequired: boolean;
  reason: string;
  lag?: number;
  playbackUrl?: string;
}

/**
 * Establish whether RHPSL has playable live video right now.
 *
 * Without a token the session call fails at the application layer, which is
 * reported as credentialRequired rather than "offline": the difference matters
 * to an operator who needs to know a paid subscription is the blocker.
 */
export async function rhpslStatus(
  slug: string,
  fetchImpl: typeof fetch,
  hooks: RhpslHooks = {},
): Promise<RhpslStatus> {
  const open = hooks.openSession ?? defaultOpenSession(fetchImpl);
  let session: RhpslSession | null = null;
  try {
    session = await Promise.race([
      open(slug, undefined),
      new Promise<null>((resolve) => setTimeout(resolve, 6000, null)),
    ]);
  } catch {
    session = null;
  }
  if (!session?.playbackUrl) {
    return {
      available: false,
      credentialRequired: true,
      reason: 'live video requires an RHPSL customer subscription',
    };
  }
  const lag = hooks.mediaLag ? await hooks.mediaLag(session.playbackUrl) : 0;
  if (lag === null) {
    return { available: false, credentialRequired: false, reason: 'no valid live segment timestamp' };
  }
  return { available: true, credentialRequired: false, reason: 'live media', lag: lag ?? undefined, playbackUrl: session.playbackUrl };
}

/**
 * Default session creation: the exact call the site itself makes. The customer
 * bearer token is the only credential that unlocks it, so it arrives from
 * configuration and is never inferred or fabricated.
 */
function defaultOpenSession(fetchImpl: typeof fetch) {
  return async (slug: string, token: string | undefined): Promise<RhpslSession | null> => {
    if (!token) return null;
    const response = await fetchImpl(API + '/playback/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ venueSlug: slug }),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as Record<string, unknown>;
    if (payload.success !== true) return null;
    const data = payload.data as Record<string, unknown> | undefined;
    const playbackUrl = text(data?.playbackUrl);
    if (!playbackUrl) return null;
    return { playbackUrl, credentialed: data?.credentialed === true };
  };
}

/** Public racecard: no credentials needed for any venue. */
export async function rhpslRaceCard(
  slug: string,
  fetchImpl: typeof fetch,
): Promise<RhpslRaceCard | null> {
  try {
    const response = await fetchImpl(API + '/public/venues/' + encodeURIComponent(slug) + '/racecard');
    if (!response.ok) return null;
    return parseRaceCard(await response.json());
  } catch {
    return null;
  }
}
