import { pathToFileURL } from 'node:url';

export async function purgeProductionHtmlCache({
  apiToken,
  zoneId,
  publicUrl,
  expectedAssetPath,
  fetchImpl = fetch,
}) {
  if (!apiToken?.trim()) throw new Error('CLOUDFLARE_API_TOKEN is required');
  if (!zoneId?.trim()) throw new Error('CLOUDFLARE_ZONE_ID is required');
  if (!expectedAssetPath?.startsWith('/assets/index-')) {
    throw new Error('expected production entry asset path is missing or invalid');
  }

  const origin = new URL(publicUrl);
  if (origin.protocol !== 'https:') {
    throw new Error('production public URL must use HTTPS');
  }
  const rootUrl = new URL('/', origin).toString();
  const indexUrl = new URL('/index.html', origin).toString();
  const apiUrl = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/purge_cache`;

  const purgeResponse = await fetchImpl(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ files: [rootUrl, indexUrl] }),
  });

  let purgeResult;
  try {
    purgeResult = await purgeResponse.json();
  } catch {
    throw new Error(`Cloudflare cache purge returned invalid JSON (HTTP ${purgeResponse.status})`);
  }
  if (!purgeResponse.ok || purgeResult?.success !== true) {
    const detail = purgeResult?.errors?.map(error => error.message).filter(Boolean).join('; ');
    throw new Error(
      `Cloudflare cache purge failed (HTTP ${purgeResponse.status})${detail ? `: ${detail}` : ''}`
    );
  }

  const shellResponse = await fetchImpl(rootUrl, { cache: 'no-store' });
  if (!shellResponse.ok) {
    throw new Error(`production HTML check failed (HTTP ${shellResponse.status})`);
  }
  const cacheStatus = shellResponse.headers.get('cf-cache-status');
  if (cacheStatus?.toUpperCase() === 'HIT') {
    throw new Error('production HTML is still cached after purge');
  }
  const html = await shellResponse.text();
  const entry = html.match(/<script\b[^>]*\bsrc=["']([^"']*\/assets\/index-[^"']+\.js)["']/i)?.[1];
  const entryPath = entry ? new URL(entry, rootUrl).pathname : '';
  if (entryPath !== expectedAssetPath) {
    throw new Error(
      `production HTML entrypoint mismatch: expected ${expectedAssetPath}, got ${entryPath || 'none'}`
    );
  }

  const assetResponse = await fetchImpl(new URL(entryPath, rootUrl), { cache: 'no-store' });
  if (!assetResponse.ok) {
    throw new Error(`production entry asset check failed (HTTP ${assetResponse.status})`);
  }

  return { rootUrl, assetPath: entryPath, cacheStatus: cacheStatus ?? 'unreported' };
}

async function main() {
  const expectedAssetPath = process.env.PONSWARP_EXPECTED_ENTRY_ASSET;
  const result = await purgeProductionHtmlCache({
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    zoneId: process.env.CLOUDFLARE_ZONE_ID,
    publicUrl: process.env.PONSWARP_PUBLIC_URL || 'https://warp.ponslink.com',
    expectedAssetPath,
  });
  console.log(JSON.stringify({ ok: true, ...result }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
