import {
  decodeFrame,
  decodeJsonPayload,
  encodeAck,
  encodeFrame,
  encodeJsonPayload,
  FLAG_KEYFRAME,
  FrameError,
  FrameType,
  isDownstreamType,
  MAX_DOWNSTREAM_PAYLOAD,
  type TControlDown,
  type TControlUp,
  type TInputEvent,
  type TVideoConfig,
  type TViewerHello
} from "@app/lib/pam-web-app/contract";

import { splitInputBatches } from "../input/InputBatcher";
import { AckScheduler } from "./AckScheduler";
import { canSendInput, controlReducer, isTerminalPhase } from "./controlReducer";
import { KeyframeRequester } from "./KeyframeRequester";
import {
  initialViewerState,
  type TClock,
  type TLiveDecoderPort,
  type TSessionSocket,
  type TViewerError,
  type TViewerState
} from "./types";

export const END_SESSION_TIMEOUT_MS = 5000;

export const WS_NORMAL_CLOSURE = 1000;

const MAX_SEQ = 0xffffffff;

type Options = {
  socket: TSessionSocket;
  decoder: TLiveDecoderPort;
  clock: TClock;
  hello: TViewerHello;
  onStateChange?: (state: TViewerState) => void;
};

// One instance per viewer link (one WebSocket). A reconnect builds a new client, so upstream seq restarts at 0.
export class WebAppSessionClient {
  private state: TViewerState = initialViewerState;

  private seq = 0;

  private openedAt = 0;

  private started = false;

  private endTimer: number | null = null;

  private readonly acks: AckScheduler;

  private readonly keyframes: KeyframeRequester;

  constructor(private readonly options: Options) {
    this.acks = new AckScheduler(options.clock, (ackSeq) =>
      this.sendFrame(FrameType.Ack, encodeAck(ackSeq, this.options.decoder.decodeQueueSize))
    );
    this.keyframes = new KeyframeRequester(options.clock, () =>
      this.sendFrame(FrameType.KeyframeRequest, new Uint8Array(0))
    );
  }

  getState() {
    return this.state;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.openedAt = this.options.clock.now();
    this.sendFrame(FrameType.Hello, encodeJsonPayload(this.options.hello));
    this.setState({ ...this.state, phase: "awaiting_ready" });
  }

  handleMessage(data: ArrayBuffer | string) {
    if (this.isTerminal()) return;
    if (typeof data === "string") {
      this.fail({ code: "protocol_error", message: "Unexpected text message on the stream" });
      return;
    }
    try {
      const frame = decodeFrame(new Uint8Array(data), MAX_DOWNSTREAM_PAYLOAD);
      if (!isDownstreamType(frame.type)) {
        throw new FrameError("protocol_error", `unexpected frame type ${frame.type}`);
      }
      switch (frame.type) {
        case FrameType.VideoConfig:
          this.handleVideoConfig(decodeJsonPayload<TVideoConfig>(frame.payload));
          break;
        case FrameType.VideoChunk: {
          // eslint-disable-next-line no-bitwise
          const keyframe = (frame.flags & FLAG_KEYFRAME) !== 0;
          const decoded = this.options.decoder.decode({
            seq: frame.seq,
            keyframe,
            timestampUs: frame.timestampUs,
            data: frame.payload
          });
          this.acks.onChunk(frame.seq, keyframe && decoded);
          break;
        }
        case FrameType.Control:
          this.handleControl(decodeJsonPayload<TControlDown>(frame.payload));
          break;
        default:
          // CLIPBOARD_DOWN is reserved in v1; unknown downstream types are ignored.
          break;
      }
    } catch (err) {
      if (err instanceof FrameError) {
        this.fail({ code: err.code, message: err.message });
      } else if (err instanceof SyntaxError) {
        this.fail({ code: "protocol_error", message: "Malformed JSON payload" });
      } else {
        this.fail({
          code: "client_error",
          message: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  handleClose(code: number) {
    this.acks.stop();
    this.clearEndTimer();
    if (this.state.phase === "ending") {
      this.setState({ ...this.state, phase: "ended", endReason: "user_end", closeCode: code });
    } else if (!this.isTerminal()) {
      this.setState({ ...this.state, phase: "disconnected", inputEnabled: false, closeCode: code });
    }
    this.options.decoder.close();
  }

  sendInput(events: TInputEvent[]): boolean {
    if (!canSendInput(this.state) || events.length === 0) return false;
    splitInputBatches(events).forEach((payload) => this.sendFrame(FrameType.Input, payload));
    return true;
  }

  sendControl(control: TControlUp) {
    if (!this.started || this.isTerminal()) return;
    this.sendFrame(FrameType.ControlUp, encodeJsonPayload(control));
  }

  endSession() {
    if (this.isTerminal() || this.state.phase === "ending") return;
    this.sendControl({ kind: "end_session" });
    this.setState({ ...this.state, phase: "ending", inputEnabled: false });
    this.endTimer = this.options.clock.setTimeout(() => {
      this.endTimer = null;
      this.options.socket.close(WS_NORMAL_CLOSURE, "end session timeout");
    }, END_SESSION_TIMEOUT_MS);
  }

  requestKeyframe(): boolean {
    if (!this.started || this.isTerminal()) return false;
    return this.keyframes.request();
  }

  dispose() {
    this.acks.stop();
    this.clearEndTimer();
    this.options.decoder.close();
  }

  private handleVideoConfig(config: TVideoConfig) {
    const previous = this.state.videoConfig;
    this.options.decoder.configure(config);
    this.setState({ ...this.state, videoConfig: config });
    if (previous && previous.epoch !== config.epoch) this.requestKeyframe();
  }

  private handleControl(control: TControlDown) {
    const reduced = controlReducer(this.state, control);
    if (reduced === this.state) return;
    const next =
      control.kind === "time_left" ? { ...reduced, timeLeftAt: this.options.clock.now() } : reduced;
    if (control.kind === "stream_shown") this.requestKeyframe();
    this.setState(next);
    if (next.phase === "ended" || next.phase === "failed") {
      this.acks.stop();
      this.clearEndTimer();
    }
  }

  abort(error: TViewerError) {
    if (!this.isTerminal()) this.fail(error);
  }

  private fail(error: TViewerError) {
    this.setState({ ...this.state, phase: "failed", inputEnabled: false, error });
    this.acks.stop();
    this.clearEndTimer();
    this.options.socket.close(WS_NORMAL_CLOSURE, error.code);
  }

  private sendFrame(type: FrameType, payload: Uint8Array) {
    const elapsedUs = Math.max(0, Math.round((this.options.clock.now() - this.openedAt) * 1000));
    this.options.socket.send(
      encodeFrame({ type, flags: 0, seq: this.seq, timestampUs: BigInt(elapsedUs), payload })
    );
    this.seq = this.seq === MAX_SEQ ? 0 : this.seq + 1;
  }

  private clearEndTimer() {
    if (this.endTimer !== null) this.options.clock.clearTimeout(this.endTimer);
    this.endTimer = null;
  }

  private isTerminal() {
    return isTerminalPhase(this.state.phase);
  }

  private setState(next: TViewerState) {
    this.state = next;
    this.options.onStateChange?.(next);
  }
}
