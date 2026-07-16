export function getRtcConfiguration(): RTCConfiguration {
  const stun = process.env.NEXT_PUBLIC_STUN_URLS?.split(",").filter(Boolean) ?? [
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
  ];

  const iceServers: RTCIceServer[] = stun.map((urls) => ({ urls }));

  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL;
  const turnUser = process.env.NEXT_PUBLIC_TURN_USERNAME;
  const turnPass = process.env.NEXT_PUBLIC_TURN_CREDENTIAL;

  if (turnUrl) {
    iceServers.push({
      urls: turnUrl,
      username: turnUser,
      credential: turnPass,
    });
  }

  return {
    iceServers,
    iceCandidatePoolSize: 4,
  };
}

export function detectConnectionMode(stats: RTCStatsReport | null): "direct" | "relay" | "unknown" {
  if (!stats) return "unknown";

  let selectedPairId: string | null = null;
  for (const report of stats.values()) {
    if (report.type === "transport" && "selectedCandidatePairId" in report) {
      const id = (report as RTCTransportStats & { selectedCandidatePairId?: string }).selectedCandidatePairId;
      if (id) selectedPairId = String(id);
    }
  }

  const pairs: RTCIceCandidatePairStats[] = [];
  for (const report of stats.values()) {
    if (report.type === "candidate-pair") pairs.push(report as RTCIceCandidatePairStats);
  }

  const selected =
    (selectedPairId ? pairs.find((p) => p.id === selectedPairId) : undefined) ||
    pairs.find((p) => p.nominated && p.state === "succeeded") ||
    pairs.find((p) => p.state === "succeeded") ||
    pairs.find((p) => p.nominated);

  if (!selected) return "unknown";

  const local = stats.get(selected.localCandidateId) as (RTCStats & { candidateType?: string }) | undefined;
  const remote = stats.get(selected.remoteCandidateId) as (RTCStats & { candidateType?: string }) | undefined;
  if (local?.candidateType === "relay" || remote?.candidateType === "relay") return "relay";
  if (local?.candidateType || remote?.candidateType) return "direct";
  return "unknown";
}
