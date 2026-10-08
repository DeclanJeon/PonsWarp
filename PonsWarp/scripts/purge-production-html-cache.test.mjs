import assert from 'node:assert/strict';
import { test } from 'node:test';
import { purgeProductionHtmlCache } from './purge-production-html-cache.mjs';

const origin = 'https://warp.ponslink.com';
const expectedAssetPath = '/assets/index-release.js';

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers });
}

test('purges only production HTML and verifies the active release entrypoint', async () => {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes('/purge_cache')) return response('{"success":true}');
    if (url === `${origin}/`) {
      return response(`<script type="module" src="${expectedAssetPath}"></script>`, {
        headers: { 'cf-cache-status': 'MISS' },
      });
    }
    if (url === `${origin}${expectedAssetPath}`) return response('release asset');
    throw new Error(`unexpected URL ${url}`);
  };

  const result = await purgeProductionHtmlCache({
    apiToken: 'test-token',
    zoneId: 'test-zone',
    publicUrl: origin,
    expectedAssetPath,
    fetchImpl,
  });

  assert.deepEqual(JSON.parse(requests[0].init.body), {
    files: [`${origin}/`, `${origin}/index.html`],
  });
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer test-token');
  assert.equal(requests[1].url, `${origin}/`);
  assert.equal(requests[2].url, `${origin}${expectedAssetPath}`);
  assert.equal(result.assetPath, expectedAssetPath);
  assert.equal(result.cacheStatus, 'MISS');
});

test('rejects a stale edge-cached HTML shell after purge', async () => {
  const fetchImpl = async input => {
    const url = String(input);
    if (url.includes('/purge_cache')) return response('{"success":true}');
    if (url === `${origin}/`) {
      return response('<script src="/assets/index-old.js"></script>', {
        headers: { 'cf-cache-status': 'HIT' },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  await assert.rejects(
    purgeProductionHtmlCache({
      apiToken: 'test-token',
      zoneId: 'test-zone',
      publicUrl: origin,
      expectedAssetPath,
      fetchImpl,
    }),
    /still cached|expected entrypoint/i
  );
});

test('rejects Cloudflare API failures without checking the public entrypoint', async () => {
  let publicRequests = 0;
  const fetchImpl = async () => {
    publicRequests += 1;
    return response('{"success":false,"errors":[{"message":"bad token"}]}');
  };

  await assert.rejects(
    purgeProductionHtmlCache({
      apiToken: 'bad-token',
      zoneId: 'test-zone',
      publicUrl: origin,
      expectedAssetPath,
      fetchImpl,
    }),
    /Cloudflare cache purge failed/i
  );
  assert.equal(publicRequests, 1);
});
