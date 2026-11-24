import Phaser from 'phaser';
import { CounterScene } from './CounterScene.js';
import { createCounterConnection } from './connection.js';

const connection = createCounterConnection();

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: 1920,
  height: 1080,
  backgroundColor: '#0b1220',
  scale: {
    mode: Phaser.Scale.ScaleModes.ENVELOP,
    autoCenter: Phaser.Scale.Center.CENTER_BOTH,
    min: { width: 960, height: 544 },
    max: { width: 3840, height: 2160 },
    zoom: 1,
  },
  scene: [new CounterScene(connection)],
});

// The scene also disconnects on shutdown; this covers a page being unloaded
// without a clean scene teardown. Both paths are idempotent.
window.addEventListener('pagehide', () => connection.disconnect());
