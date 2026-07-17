/**
 * ICE server ordering helpers.
 * Prefer STUN/direct gathering before TURN so LAN host candidates appear first.
 */
export function orderIceServersPreferDirect(
  servers: RTCIceServer[] | null | undefined
): RTCIceServer[] {
  if (!servers || servers.length === 0) return [];
  const stun: RTCIceServer[] = [];
  const turn: RTCIceServer[] = [];
  const other: RTCIceServer[] = [];
  for (const server of servers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    const joined = urls.map(u => String(u).toLowerCase()).join(' ');
    if (joined.includes('turn:')) turn.push(server);
    else if (joined.includes('stun:')) stun.push(server);
    else other.push(server);
  }
  return [...stun, ...other, ...turn];
}
