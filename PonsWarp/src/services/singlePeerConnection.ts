/**
 * SinglePeerConnection — compatibility facade over native PeerSession.
 *
 * Historically backed by simple-peer. Now always uses native RTCPeerConnection
 * with separate control + bulk DataChannels (webrtc-bulk-throughput.md).
 */
export {
  PeerSession as SinglePeerConnection,
  type PeerConfig,
  type PeerState,
  type PeerSignalMessage,
} from './peerSession';
