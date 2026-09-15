/**
 * Pre-flight NAT/path probe (Tailscale netcheck analogue).
 *
 * Runs a throwaway RTCPeerConnection against the configured STUN server and
 * classifies the likely P2P path before a transfer starts, so the UI can warn
 * early when a relay will be needed instead of letting the user discover it
 * via a slow or failed transfer.
 */

export type NatProbeVerdict =
  | 'direct' // host + srflx candidates — direct P2P likely
  | 'host-only' // only host candidates — LAN-only or no NAT mapping visible
  | 'relay-likely' // no srflx — symmetric NAT / restricted UDP, TURN likely needed
  | 'blocked' // no candidates at all — UDP likely blocked
  | 'unavailable'; // probe could not run

export interface NatProbeResult {
  verdict: NatProbeVerdict;
  /** true when at least one srflx (server-reflexive) candidate was gathered */
  hasSrflx: boolean;
  /** true when at least one relay candidate was gathered */
  hasRelay: boolean;
  /** elapsed probe time in ms */
  elapsedMs: number;
}

const PROBE_TIMEOUT_MS = 3500;

/**
 * Gather ICE candidates on a temporary PeerConnection and classify the path.
 * Never throws — returns 'unavailable' on any failure.
 */
export async function probeNatPath(
  iceServers: RTCIceServer[]
): Promise<NatProbeResult> {
  const started = Date.now();
  if (typeof RTCPeerConnection !== 'function') {
    return {
      verdict: 'unavailable',
      hasSrflx: false,
      hasRelay: false,
      elapsedMs: 0,
    };
  }

  let pc: RTCPeerConnection | null = null;
  try {
    pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: 'all',
      iceCandidatePoolSize: 0,
    });

    const result = await new Promise<NatProbeResult>(resolve => {
      let hasSrflx = false;
      let hasRelay = false;
      let hasHost = false;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        const elapsedMs = Date.now() - started;
        let verdict: NatProbeVerdict;
        if (hasSrflx) verdict = 'direct';
        else if (hasRelay) verdict = 'relay-likely';
        else if (hasHost) verdict = 'host-only';
        else verdict = 'blocked';
        resolve({ verdict, hasSrflx, hasRelay, elapsedMs });
      };

      const timer = setTimeout(finish, PROBE_TIMEOUT_MS);
      const done = () => {
        clearTimeout(timer);
        finish();
      };

      pc!.onicecandidate = event => {
        if (!event.candidate) {
          done();
          return;
        }
        const cand = event.candidate.candidate || '';
        const type = /\btyp\s+(host|srflx|prflx|relay)\b/.exec(cand)?.[1];
        if (type === 'srflx' || type === 'prflx') hasSrflx = true;
        else if (type === 'relay') hasRelay = true;
        else if (type === 'host') hasHost = true;
      };
      pc!.onicegatheringstatechange = () => {
        if (pc!.iceGatheringState === 'complete') done();
      };
      pc!.onicecandidateerror = () => {
        // STUN unreachable — keep waiting for other candidates until timeout.
      };

      // A data channel is required to trigger ICE gathering.
      pc!.createDataChannel('probe');
      void pc!
        .createOffer()
        .then(offer => pc!.setLocalDescription(offer))
        .catch(done);
    });

    return result;
  } catch {
    return {
      verdict: 'unavailable',
      hasSrflx: false,
      hasRelay: false,
      elapsedMs: Date.now() - started,
    };
  } finally {
    try {
      pc?.close();
    } catch {
      // ignore
    }
  }
}

/** Human-facing hint for a verdict; null when no warning is warranted. */
export function natProbeHint(result: NatProbeResult): string | null {
  switch (result.verdict) {
    case 'relay-likely':
      return 'This network may require a relay (TURN). Transfers can be slower but will still work.';
    case 'blocked':
      return 'UDP appears blocked on this network. Transfers will use the relay path.';
    case 'host-only':
      return 'Only local network candidates found. Direct transfer works on the same network; remote peers may need a relay.';
    default:
      return null;
  }
}
