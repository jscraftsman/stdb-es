/**
 * Shared surface: error codes, protocol types, and the stream-id helper.
 * Safe to import from client code because nothing here pulls in the server
 * module runtime.
 */
export * from './errors.js';
export * from './stream-id.js';
export * from './server/protocol.js';
