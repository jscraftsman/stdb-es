import Phaser from 'phaser';
import { COUNTER_ID, COUNTER_STREAM_ID } from './domains/counter/ids.js';
import type { CounterConnection, SummarySnapshot } from './connection.js';
import { createSceneCommands } from './counter-client.js';
import type { CounterCommandClient } from './domains/counter/api.js';

const WIDTH = 1920;
const HEIGHT = 1080;
const CENTER_X = WIDTH / 2;
const CENTER_Y = HEIGHT / 2;
const PANEL_WIDTH = 940;
const PANEL_HEIGHT = 540;

// Rows are offsets from the game center so the whole panel stays centered.
const TITLE_Y = CENTER_Y - 180;
const STATUS_Y = CENTER_Y - 140;
const VALUE_Y = CENTER_Y - 65;
const META_Y = CENTER_Y - 5;
const AMOUNT_Y = CENTER_Y + 60;
const ACTION_Y = CENTER_Y + 125;
const MESSAGE_Y = CENTER_Y + 190;

const BUTTON_HEIGHT = 42;
const ACTION_BUTTON_WIDTH = 150;
const ACTION_BUTTON_GAP = 16;

/**
 * Phaser owns rendering and scene input only. Reads and writes go through the
 * framework-neutral generated client and `stdb-es` command wrapper.
 */
export class CounterScene extends Phaser.Scene {
  private readonly connection: CounterConnection;
  private readonly commands: CounterCommandClient;
  private unsubscribeStatus?: () => void;
  private unsubscribeSummary?: () => void;

  private status = 'Connecting…';
  private snapshot: SummarySnapshot = { rows: [], ready: false };
  private amount = 1;
  private busy = false;
  private message = 'Commands send intent only; the module owns the event log.';

  private valueText!: Phaser.GameObjects.Text;
  private metaText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private amountText!: Phaser.GameObjects.Text;
  private messageText!: Phaser.GameObjects.Text;
  private readonly buttons: Phaser.GameObjects.Container[] = [];

  constructor(connection: CounterConnection) {
    super('counter');
    this.connection = connection;
    this.commands = createSceneCommands(connection);
  }

  create(): void {
    this.cameras.main.setBackgroundColor('#0b1220');

    this.add.rectangle(CENTER_X, CENTER_Y, PANEL_WIDTH, PANEL_HEIGHT, 0x111c2e);
    this.add
      .text(CENTER_X, TITLE_Y, 'stdb-es counter with Phaser', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '30px',
        color: '#f8fafc',
      })
      .setOrigin(0.5);

    this.statusText = this.add
      .text(CENTER_X, STATUS_Y, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '15px',
        color: '#93c5fd',
      })
      .setOrigin(0.5);

    this.valueText = this.add
      .text(CENTER_X, VALUE_Y, 'Loading…', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '64px',
        fontStyle: 'bold',
        color: '#ffffff',
      })
      .setOrigin(0.5);

    this.metaText = this.add
      .text(CENTER_X, META_Y, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '14px',
        color: '#94a3b8',
      })
      .setOrigin(0.5);

    // Amount row: centered as one group around the game's horizontal center.
    this.amountText = this.add
      .text(CENTER_X - 80, AMOUNT_Y, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '22px',
        color: '#e2e8f0',
      })
      .setOrigin(0.5);
    this.makeButton('−', CENTER_X + 30, AMOUNT_Y, () => this.changeAmount(-1), 52);
    this.makeButton('+', CENTER_X + 100, AMOUNT_Y, () => this.changeAmount(1), 52);

    // Action row: three equal buttons with equal gaps, centered on CENTER_X.
    const actionStep = ACTION_BUTTON_WIDTH + ACTION_BUTTON_GAP;
    this.makeButton('Increment', CENTER_X - actionStep, ACTION_Y, () => void this.send('increment'));
    this.makeButton('Decrement', CENTER_X, ACTION_Y, () => void this.send('decrement'));
    this.makeButton('Reset', CENTER_X + actionStep, ACTION_Y, () => void this.send('reset'));

    this.messageText = this.add
      .text(CENTER_X, MESSAGE_Y, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '14px',
        color: '#fbbf24',
        align: 'center',
        wordWrap: { width: PANEL_WIDTH - 80 },
      })
      .setOrigin(0.5);

    // Explicit frontend lifecycle: register callbacks, subscribe, then tear
    // everything down in reverse order when the scene shuts down.
    this.unsubscribeStatus = this.connection.onStatus((status) => {
      this.status = status;
      this.refresh();
    });
    this.unsubscribeSummary = this.connection.onSummary((snapshot) => {
      this.snapshot = snapshot;
      this.refresh();
    });
    this.connection.connect();

    this.events.once('shutdown', () => {
      this.unsubscribeStatus?.();
      this.unsubscribeSummary?.();
      this.connection.disconnect();
    });

    this.refresh();
  }

  private changeAmount(delta: number): void {
    if (this.busy) return;
    this.amount = Math.max(1, this.amount + delta);
    this.refresh();
  }

  private async send(name: 'increment' | 'decrement' | 'reset'): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.setMessage('Sending command…');
    try {
      if (name === 'reset') {
        await this.commands.sendNew('reset', { counterId: COUNTER_ID });
      } else {
        await this.commands.sendNew(name, { counterId: COUNTER_ID, by: this.amount });
      }
      this.setMessage('Command accepted. The view refreshes when the subscription applies.');
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      this.setMessage(
        detail.includes('CMD_UNAUTHORIZED')
          ? 'Only this counter’s owner can change it.'
          : `Command rejected: ${detail}`,
      );
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  private setMessage(message: string): void {
    this.message = message;
    this.refresh();
  }

  private makeButton(
    label: string,
    x: number,
    y: number,
    onClick: () => void,
    width = ACTION_BUTTON_WIDTH,
  ): void {
    const background = this.add.rectangle(0, 0, width, BUTTON_HEIGHT, 0x2563eb);
    const text = this.add
      .text(0, 0, label, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: width < 80 ? '24px' : '16px',
        color: '#ffffff',
      })
      .setOrigin(0.5);
    const button = this.add.container(x, y, [background, text]);
    button.setSize(width, BUTTON_HEIGHT);
    button.setInteractive({ useHandCursor: true });
    button.on('pointerdown', onClick);
    this.buttons.push(button);
  }

  private refresh(): void {
    if (!this.valueText) return;

    const row = this.snapshot.rows.find(
      (candidate) => candidate.streamId === COUNTER_STREAM_ID,
    );
    this.valueText.setText(this.snapshot.ready ? String(row?.value ?? 0n) : 'Loading…');
    this.metaText.setText(`stream ${COUNTER_STREAM_ID} · version ${row?.version ?? 0}`);
    this.statusText.setText(this.status);
    this.amountText.setText(`Amount: ${this.amount}`);
    this.messageText.setText(this.message);
    for (const button of this.buttons) button.setAlpha(this.busy ? 0.5 : 1);
  }
}
