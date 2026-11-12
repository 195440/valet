import { claimStdout } from "./stdio.js";

/**
 * Imported first by server.ts so that nothing loaded after it can print to the protocol channel.
 * ES modules evaluate in import order, which is the whole trick.
 */
export const writeToClient = claimStdout();
