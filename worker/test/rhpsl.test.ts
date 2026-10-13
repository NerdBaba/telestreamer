import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRaceCard, rhpslStatus } from '../src/rhpsl';

const CARD = {
  success: true,
  data: {
    available: true,
    versionNumber: 1,
    updatedAt: '2026-10-12T01:52:42.000Z',
    raceCard: {
      venueCode: 'HYD',
      venueName: 'HYDERABAD (IND)',
      date: '2026-10-12',
      races: [
        {
          raceNumber: 1,
          raceName: 'The Nirmal Plate Div-2',
          startTime: '00:40',
          distance: '1200m',
          runners: [
            { number: 1, horseName: 'SHOOTING STAR', jockey: 'Deepak Singh', trainer: 'R H Sequeira', weight: '60kg', draw: 3, rating: '45', silkUrl: 'https://x/1.png', description: 'b m 5y' },
            { number: 2, horseName: 'AMERICAN AFFAIR', jockey: 'A Ashhad Asbar', trainer: 'Ananta Vatsalya', weight: '56.5kg', draw: 1, rating: '38', silkUrl: 'https://x/2.png', description: 'b f 4y' },
          ],
        },
      ],
    },
  },
};

test('racecard normalizes into the public race API shape', () => {
  const card = parseRaceCard(CARD);
  assert.equal(card.raceDate, '2026-10-12');
  assert.equal(card.venueName, 'HYDERABAD (IND)');
  assert.equal(card.venueCode, 'HYD');
  assert.equal(card.races.length, 1);
  assert.equal(card.races[0].number, 1);
  assert.equal(card.races[0].name, 'The Nirmal Plate Div-2');
  assert.equal(card.races[0].time, '00:40');
  assert.equal(card.races[0].runners.length, 2);
  const runner = card.races[0].runners[0];
  assert.equal(runner.number, 1);
  assert.equal(runner.horseName, 'SHOOTING STAR');
  assert.equal(runner.jockey, 'Deepak Singh');
  assert.equal(runner.draw, 3);
  assert.equal(runner.rating, '45');
  assert.equal(runner.silkImage, 'https://x/1.png');
});

test('unavailable or malformed racecards are never reported as media', () => {
  assert.equal(parseRaceCard({ success: true, data: { available: false } }), null);
  assert.equal(parseRaceCard({ success: false }), null);
  assert.equal(parseRaceCard({ success: true, data: { raceCard: { races: 'bad' } } }), null);
  assert.equal(parseRaceCard(null), null);
});

test('live video requires a customer session and is never faked', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing bearer token' } }), { status: 401 });
  const status = await rhpslStatus('hyderabad', fetchImpl);
  assert.equal(status.available, false);
  assert.equal(status.credentialRequired, true);
  assert.match(status.reason, /subscription|credential/i);
});

test('a verified live session produces a streamable HLS master', async () => {
  const playlist = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2\n#EXT-X-PROGRAM-DATE-TIME:2026-10-12T01:30:00Z\nseg1.ts\n';
  const session = { playbackUrl: 'https://cdn.example/hyd/master.m3u8', credentialed: false };
  const responses = {
    'https://cdn.example/hyd/master.m3u8': new Response(playlist, {
      status: 200,
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
    }),
  };
  const fetchImpl = async (input) => responses[String(input)] ?? new Response('missing', { status: 404 });
  const status = await rhpslStatus('hyderabad', fetchImpl, {
    openSession: () => Promise.resolve(session),
    mediaLag: () => 3,
  });
  assert.equal(status.available, true);
  assert.equal(status.lag, 3);
  assert.equal(status.playbackUrl, session.playbackUrl);
});
