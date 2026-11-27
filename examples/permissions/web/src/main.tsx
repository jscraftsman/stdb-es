import React from 'react';
import ReactDOM from 'react-dom/client';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import App from './App.js';
import {
  DATABASE_NAME,
  readAnonymousToken,
  readGoogleCredential,
  SPACETIMEDB_URI,
  writeAnonymousToken,
} from './config.js';
import { DbConnection } from './generated/index.js';
import './styles.css';

const googleCredential = readGoogleCredential();

const connectionBuilder = DbConnection.builder()
  .withUri(SPACETIMEDB_URI)
  .withDatabaseName(DATABASE_NAME)
  // No Google credential means an anonymous connection, which is enough for C1.
  .withToken(googleCredential ?? readAnonymousToken())
  .withAutomaticReconnect()
  .onConnect((_connection, _identity, token) => {
    // Never persist a Google-derived token as the anonymous token: sign-out
    // must actually return to an anonymous identity.
    if (googleCredential === undefined) writeAnonymousToken(token);
  });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <App />
    </SpacetimeDBProvider>
  </React.StrictMode>,
);
