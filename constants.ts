export const APP_NAME = "PonsWarp";
export const MAX_CHANNELS = 4; // Number of WebRTC DataChannels to use simultaneously
export const CHUNK_SIZE_INITIAL = 64 * 1024; 
export const CHUNK_SIZE_MAX = 256 * 1024;
export const SIGNALING_SERVER_URL =  process.env.SIGNALING_SERVER_URL;
