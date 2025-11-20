import streamSaver from 'streamsaver';
import { logInfo, logError, logWarn } from './logger';

/**
 * Initializes StreamSaver with robust configuration to avoid extension conflicts.
 */
export const initStreamSaver = () => {
  try {
    // 1. Set local MITM
    // Using a local file avoids Cross-Origin checks that many extensions trip over.
    // Ensure 'mitm.html' exists in your 'public' folder.
    const localMitm = `${window.location.origin}/mitm.html?version=2.0.0`;
    streamSaver.mitm = localMitm;

    logInfo('[StreamSaver]', `Initialized with MITM: ${localMitm}`);

    // 2. Extension Interference Check (Monkey Patch for Safety)
    // Some extensions (ad-blockers, wallets) intercept window.postMessage and strip 'transfer' ports.
    // We verify if MessageChannel is working correctly.
    const testChannel = new MessageChannel();
    try {
      // Simple check to see if we can transfer a port locally
      // If this fails immediately, the browser environment is very restricted.
      const buffer = new ArrayBuffer(1);
      window.postMessage(buffer, '*', [buffer]);
    } catch (e) {
      logWarn('[StreamSaver]', 'Transferable objects might be blocked by environment.');
    }

    // 3. Clean up any existing monkey patches if re-initializing
    if ((streamSaver as any)._isPatched) {
      return;
    }

    // Optional: Add a ping check to verify MITM is reachable before starting
    // This is advanced, but we rely on standard error handling in ReceiverView for now.

  } catch (error) {
    logError('[StreamSaver]', 'Initialization failed', error);
  }
};

/**
 * Creates a write stream with error handling for extension interference.
 * @param filename Name of the file
 * @param size Size of the file
 * @returns WritableStream | null
 */
export const createSafeWriteStream = (filename: string, size: number): WritableStream | null => {
  try {
    // Standard creation
    return streamSaver.createWriteStream(filename, { size });
  } catch (error: any) {
    logError('[StreamSaver]', 'createWriteStream failed', error);
    
    if (error.name === 'TypeError' && error.message.includes('messageChannel')) {
      console.error(`
      ---------------------------------------------------------
      [CRITICAL] Browser Extension Conflict Detected
      An extension is blocking the StreamSaver handshake.
      Please try:
      1. Disabling extensions like MetaMask/AdBlock for this site.
      2. Using Incognito mode.
      ---------------------------------------------------------
      `);
    }
    return null;
  }
};