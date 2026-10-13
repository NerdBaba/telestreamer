import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index';

test('newest same-day published player wins even when the latest record is empty', async t => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://api.rwitc.com/login/stream') {
      return Response.json({data:[
        {id:1,race_date:'2026-10-11',createdAt:'2026-10-11T08:00:00Z',status:'active',stream_url:'https://api.rwitc.com/player/old.html'},
        {id:2,race_date:'2026-10-11',createdAt:'2026-10-11T09:00:00Z',status:'active',stream_url:'https://api.rwitc.com/player/new.html'},
        {id:3,race_date:'2026-10-11',createdAt:'2026-10-11T10:00:00Z',status:'active',stream_url:''},
      ]});
    }
    if (url.startsWith('https://api.rwitc.com/player/')) {
      const token = url.endsWith('/new.html') ? 'NEWTOKEN' : 'OLDTOKEN';
      return new Response(`fetch("https://sign.lambda-url.example/"); "https://cfs.rwitc.com/${token}/index.m3u8"`);
    }
    if (url === 'https://sign.lambda-url.example/') {
      return Response.json({status:'success',keyPairId:'fixture',encodedPolicy:'fixture',encodedSignature:'fixture'});
    }
    return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant.m3u8\n', {headers:{'Content-Type':'application/vnd.apple.mpegurl'}});
  });
  const response = await worker.fetch(new Request('https://relay.example/api/live'), {
    RWITC_API:'https://api.rwitc.com/login',RWITC_ORIGIN:'https://api.rwitc.com',
  } as Parameters<typeof worker.fetch>[1]);
  assert.equal(response.status,200);
  const variant = (await response.text()).split('\n').find(line => line && !line.startsWith('#'));
  assert.equal(variant,'/api/live/NEWTOKEN/variant.m3u8');
});
