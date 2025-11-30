// export interface PeerConfig {
//   iceServers: RTCIceServer[];
// }

export interface PeerConfig {
  iceServers: RTCIceServer[];
  isInitiator: boolean;
  id: string; // Peer ID
}