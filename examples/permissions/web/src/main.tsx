import React from 'react';
import ReactDOM from 'react-dom/client';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import App from './App.js';
import { DATABASE_NAME, SPACETIMEDB_URI, readToken, writeToken } from './config.js';
import { DbConnection } from './generated/index.js';
import './styles.css';

const connectionBuilder = DbConnection.builder()
  .withUri(SPACETIMEDB_URI)
  .withDatabaseName(DATABASE_NAME)
  .withToken(readToken())
  .withAutomaticReconnect()
  .onConnect((_connection, _identity, token) => writeToken(token));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <App />
    </SpacetimeDBProvider>
  </React.StrictMode>,
);
