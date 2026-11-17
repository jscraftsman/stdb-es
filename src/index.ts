/**
 * Shared surface: error codes and protocol types. Safe to import from client
 * code because nothing here pulls in the server module runtime.
 */
export * from './errors.js';
export * from './server/protocol.js';
