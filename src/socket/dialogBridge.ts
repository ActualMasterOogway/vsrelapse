import { EventEmitter } from 'node:events';
import { type Channel } from 'relapsesdk';
import { SocketClient } from './client';

const CHANNEL_NAME = 'vsrelapse.dialogs.v1';
const VALID_ICONS = new Set(['none', 'error', 'question', 'warning', 'information']);

export type DialogIcon = 'none' | 'error' | 'question' | 'warning' | 'information';

export interface DialogRequest {
  id: number;
  title: string;
  text: string;
  buttons: string[];
  icon: DialogIcon;
  defaultButton: number;
}

export class DialogBridge extends EventEmitter {
  private readonly client: SocketClient;
  private readonly dialogScript: string;
  private channel: Channel | null = null;
  private opening = false;
  private setup = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private readonly dialogs = new Map<number, number>();
  private session = 0;
  private deadline = 0;
  private ready = false;

  constructor(client: SocketClient, dialogScript: string) {
    super();
    this.client = client;
    this.dialogScript = dialogScript;
  }

  sync(): void {
    const session = this.client.getSession();
    if (this.session === session) return;
    this.session = session;
    this.start();
  }

  async sendChoice(id: number, choice: number): Promise<boolean> {
    const count = this.dialogs.get(id);
    if (!this.ready || !this.channel || !this.channel.connected || !count || choice < 0 || choice > count) {
      return false;
    }
    this.dialogs.delete(id);
    try {
      await this.channel.send({ op: 'choice', id, choice });
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Could not answer the dialog request');
      return false;
    }
  }

  dispose(): void {
    this.stop();
    this.removeAllListeners();
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private reset(): void {
    if (this.dialogs.size > 0) {
      this.dialogs.clear();
    }
    this.emit('reset');
  }

  private stop(): void {
    this.setup.abort();
    this.setup = new AbortController();
    this.opening = false;
    this.cancelTimer();
    if (this.channel) {
      this.channel.removeAllListeners();
      this.channel.close();
      this.channel = null;
    }
    this.ready = false;
    this.reset();
  }

  private fail(detail: string): void {
    this.stop();
    this.emit('error', detail);
  }

  private start(): void {
    this.stop();
    if (!this.session) return;

    const { signal } = this.setup;
    void this.client.execute('vsrelapse-dialogs.luau', this.dialogScript, { signal }).catch(error => {
      if (!signal.aborted) this.fail(error instanceof Error ? error.message : String(error));
    });
    this.deadline = Date.now() + 10_000;
    this.startTimer();
    void this.tick();
  }

  private startTimer(): void {
    this.cancelTimer();
    this.timer = setInterval(() => void this.tick(), 250);
  }

  private async tick(): Promise<void> {
    if (this.ready) return;
    if (Date.now() >= this.deadline) {
      this.fail('Dialog channel setup timed out');
      return;
    }
    if (this.opening || this.channel?.connected) return;
    const { signal } = this.setup;
    this.opening = true;
    try {
      const channel = await this.client.openChannel(CHANNEL_NAME, { signal });
      if (signal.aborted) {
        channel.close();
        return;
      }
      this.channel = channel;
      channel.on('message', message => this.onMessage(message));
      channel.on('close', () => {
        this.channel = null;
        if (this.ready) {
          this.ready = false;
          this.reset();
          this.deadline = Date.now() + 10_000;
          this.startTimer();
        }
      });
      this.ready = true;
      this.cancelTimer();
    } catch {
      // The bootstrap script may still be registering its channel. Retry until the deadline.
    } finally {
      if (!signal.aborted) this.opening = false;
    }
  }

  private onMessage(parsed: unknown): void {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.fail('Invalid dialog channel message');
      return;
    }

    const obj = parsed as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type : null;
    const id = obj.id;
    if (
      !type ||
      typeof id !== 'number' ||
      !Number.isInteger(id) ||
      id < 1 ||
      id > 0x7fffffff
    ) {
      this.fail('Invalid dialog channel message');
      return;
    }

    if (type === 'close') {
      if (this.dialogs.delete(id)) {
        this.emit('close', id);
      }
    } else if (type === 'open') {
      const title = obj.title;
      const text = obj.text;
      const icon = obj.icon;
      const buttons = obj.buttons;
      const defaultButton = obj.default;

      if (
        typeof title !== 'string' ||
        title.length > 255 ||
        typeof text !== 'string' ||
        text.length > 4096 ||
        typeof icon !== 'string' ||
        !VALID_ICONS.has(icon) ||
        !Array.isArray(buttons) ||
        buttons.length < 1 ||
        buttons.length > 16 ||
        typeof defaultButton !== 'number' ||
        !Number.isInteger(defaultButton) ||
        defaultButton < 1 ||
        defaultButton > buttons.length ||
        this.dialogs.has(id) ||
        this.dialogs.size >= 64
      ) {
        this.fail('Invalid dialog channel message');
        return;
      }

      const labels: string[] = [];
      for (const label of buttons) {
        if (typeof label !== 'string' || !label || Buffer.byteLength(label, 'utf8') > 128) {
          this.fail('Invalid dialog channel message');
          return;
        }
        labels.push(label);
      }

      this.dialogs.set(id, labels.length);
      this.emit('open', {
        id,
        title,
        text,
        buttons: labels,
        icon: icon as DialogIcon,
        defaultButton,
      } satisfies DialogRequest);
    } else {
      this.fail('Invalid dialog channel message');
    }
  }
}
