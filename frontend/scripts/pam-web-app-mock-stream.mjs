#!/usr/bin/env node
// Dev-only mock of the gateway side of the Web App viewer link (CONTRACTS.md section 1), so the viewer can be driven
// without the backend, gateway and runner.
//
//   node scripts/pam-web-app-mock-stream.mjs [--port 7104] [--input <video file>] [--codec vp9] [--self-check]
//
// The app CSP only allows same-origin WebSockets, so proxy a path of the dev server to the mock, for example in a
// local (uncommitted) vite config: server.proxy["/pam-web-app-mock"] = { target: "ws://127.0.0.1:7104", ws: true }.
// Then, in the browser console of the dev build:
//   localStorage.setItem("pam-web-app:mock-ws-url", "/pam-web-app-mock")
// and open any PAM account's access page. Remove the key to go back to the real flow.
//
// The video is re-encoded once with ffmpeg into H.264 Annex B (keyint 30, AUD NALs, SPS/PPS before every IDR), so
// access units split on AUDs and keyframe recovery is quick. With `--codec vp9` it also encodes VP9 (IVF) and
// streams it to viewers whose HELLO advertises vp9, like the gateway's live codec choice. Upstream frames are
// logged. Commands on stdin:
//   hide | hide-policy | show | input-off | input-on | degraded | recovered | recloss | epoch | corrupt | end |
//   error | drop
//
// The 20-byte header is encoded here because Node cannot import the TypeScript contract module directly; the
// encoder is checked against the contract test vectors at startup.

import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(here, "../src/lib/pam-web-app/contract/test-vectors/frames.json");
// The spike's recorded capture, looked up from a base checkout or from a worktree next to it.
const SPIKE_SAMPLE = "spikes/rbi-runner/evidence/run2/sample-seg001.mp4";
const DEFAULT_INPUT =
  ["../../..", "../../../.."].map((up) => join(here, up, SPIKE_SAMPLE)).find((p) => existsSync(p)) ?? "";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "7104" },
    input: { type: "string" },
    codec: { type: "string", default: "h264" },
    "self-check": { type: "boolean", default: false }
  }
});

const T = {
  VideoConfig: 0x01,
  VideoChunk: 0x02,
  Control: 0x03,
  Hello: 0x20,
  Input: 0x21,
  Ack: 0x22,
  KeyframeRequest: 0x23,
  ControlUp: 0x24
};
const TYPE_NAMES = Object.fromEntries(Object.entries(T).map(([name, value]) => [value, name]));
const HEADER = 20;
const FLAG_KEYFRAME = 1;
const MAX_UPSTREAM_PAYLOAD = 61440;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const SESSION_SECONDS = 3600;
const NAL_IDR = 5;
const NAL_SPS = 7;
const NAL_AUD = 9;

const encodeFrame = (type, flags, seq, timestampUs, payload) => {
  const out = Buffer.alloc(HEADER + payload.length);
  out.writeUInt8(1, 0);
  out.writeUInt8(type, 1);
  out.writeUInt16BE(flags, 2);
  out.writeUInt32BE(seq >>> 0, 4);
  out.writeBigUInt64BE(BigInt(timestampUs), 8);
  out.writeUInt32BE(payload.length, 16);
  Buffer.from(payload).copy(out, HEADER);
  return out;
};

const decodeFrame = (buf) => {
  if (buf.length < HEADER) throw new Error("short frame");
  if (buf.readUInt8(0) !== 1) throw new Error("bad version");
  const length = buf.readUInt32BE(16);
  if (buf.length !== HEADER + length) throw new Error("length mismatch");
  return {
    type: buf.readUInt8(1),
    flags: buf.readUInt16BE(2),
    seq: buf.readUInt32BE(4),
    timestampUs: buf.readBigUInt64BE(8),
    payload: buf.subarray(HEADER)
  };
};

const selfCheck = () => {
  const vectors = JSON.parse(readFileSync(VECTORS, "utf8"));
  const checkVector = (v) => {
    const frame = encodeFrame(v.type, v.flags, v.seq, v.timestampUs, Buffer.from(v.payloadHex, "hex"));
    if (frame.toString("hex") !== v.frameHex) throw new Error(`header self-check failed for ${v.name}`);
  };
  vectors.forEach(checkVector);
  console.log(`self-check ok (${vectors.length} vectors)`);
};

const findStartCodes = (data) => {
  const starts = [];
  for (let i = 0; i + 3 < data.length; i += 1) {
    if (data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 1) {
        starts.push({ at: i, nal: i + 3 });
        i += 2;
      } else if (data[i + 2] === 0 && data[i + 3] === 1) {
        starts.push({ at: i, nal: i + 4 });
        i += 3;
      }
    }
  }
  return starts;
};

const splitAccessUnits = (data) => {
  const units = [];
  let current = null;
  let codec = null;
  const visitNal = ({ at, nal }) => {
    const nalType = data[nal] & 0x1f;
    if (nalType === NAL_AUD) {
      if (current) units.push(current);
      current = { start: at, keyframe: false };
    }
    if (nalType === NAL_IDR && current) current.keyframe = true;
    if (nalType === NAL_SPS && !codec) {
      codec = `avc1.${[data[nal + 1], data[nal + 2], data[nal + 3]]
        .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
        .join("")}`;
    }
  };
  findStartCodes(data).forEach(visitNal);
  if (current) units.push(current);
  return {
    codec,
    units: units.map((unit, i) => ({
      keyframe: unit.keyframe,
      data: data.subarray(unit.start, i + 1 < units.length ? units[i + 1].start : data.length)
    }))
  };
};

const SOURCE_FILTER =
  "color=c=red:s=32x32[b];[0:v][b]overlay=x='mod(n*12,1240)':y=8:shortest=1,fps=30,format=yuv420p";

const H264_ARGS = [
  "-c:v", "libx264", "-profile:v", "baseline", "-level", "3.1", "-preset", "veryfast", "-tune", "zerolatency",
  "-x264-params", "keyint=30:min-keyint=30:scenecut=0:repeat-headers=1:aud=1",
  "-bsf:v", "h264_mp4toannexb", "-f", "h264"
];

// No alt-ref or lag, so every IVF frame is one displayable frame (no superframes).
const VP9_ARGS = [
  "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-g", "30",
  "-keyint_min", "30", "-lag-in-frames", "0", "-auto-alt-ref", "0", "-b:v", "1500k", "-f", "ivf"
];

const VP9_CODEC = "vp09.00.31.08";
const CORRUPT_FRAME_BYTES = 2048;
const IVF_FILE_HEADER = 32;
const IVF_FRAME_HEADER = 12;
const VP9_SHOW_EXISTING_FRAME = 0x08;
const VP9_NON_KEY_FRAME = 0x04;

const encode = (codecArgs) => {
  const dir = mkdtempSync(join(tmpdir(), "pam-web-app-mock-"));
  const out = join(dir, "live.bin");
  const input = args.input ?? DEFAULT_INPUT;
  const source = existsSync(input)
    ? ["-i", input]
    : ["-f", "lavfi", "-i", `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=10`];
  // The moving square guarantees visible change even when the recording is mostly static.
  const result = spawnSync(
    "ffmpeg",
    ["-v", "error", "-y", ...source, "-an", "-filter_complex", SOURCE_FILTER, ...codecArgs, out],
    { stdio: ["ignore", "inherit", "inherit"] }
  );
  if (result.status !== 0) throw new Error(`ffmpeg failed with status ${result.status}`);
  const data = readFileSync(out);
  rmSync(dir, { recursive: true, force: true });
  return { data, source: existsSync(input) ? input : "testsrc2" };
};

const splitIvfFrames = (data) => {
  const units = [];
  for (let off = IVF_FILE_HEADER; off + IVF_FRAME_HEADER <= data.length; ) {
    const size = data.readUInt32LE(off);
    const frame = data.subarray(off + IVF_FRAME_HEADER, off + IVF_FRAME_HEADER + size);
    units.push({
      keyframe: (frame[0] & (VP9_SHOW_EXISTING_FRAME | VP9_NON_KEY_FRAME)) === 0,
      data: frame
    });
    off += IVF_FRAME_HEADER + size;
  }
  return { codec: VP9_CODEC, units };
};

const checkStream = (name, stream, source) => {
  if (!stream.codec || stream.units.length === 0 || !stream.units[0].keyframe) {
    throw new Error(`generated ${name} stream has no codec string or does not start with a keyframe`);
  }
  console.log(
    `${name} stream ready: ${stream.units.length} frames, ${stream.units.filter((u) => u.keyframe).length} keyframes, codec ${stream.codec}, source ${source}`
  );
  return stream;
};

const generateStreams = () => {
  const h264 = encode(H264_ARGS);
  const streams = { h264: checkStream("h264", splitAccessUnits(h264.data), h264.source) };
  if (args.codec === "vp9") {
    const vp9 = encode(VP9_ARGS);
    streams.vp9 = checkStream("vp9", splitIvfFrames(vp9.data), vp9.source);
  }
  return streams;
};

const describeInputEvent = (e) => {
  if (e.t === "key") return `key:${e.action}:${e.code}:${e.key}:m${e.mods}`;
  if (e.t === "move") return `move:${e.x},${e.y}:b${e.buttons}`;
  if (e.t === "button") return `button:${e.action}:${e.button}@${e.x},${e.y}`;
  if (e.t === "wheel") return `wheel:${e.dx},${e.dy}@${e.x},${e.y}`;
  if (e.t === "ime") return `ime:${JSON.stringify(e.text)}`;
  if (e.t === "paste") return `paste:${e.id}:${e.part + 1}/${e.total}:${e.text.length}ch`;
  return e.t;
};

const describeUpstream = (frame) => {
  const name = TYPE_NAMES[frame.type] ?? `0x${frame.type.toString(16)}`;
  if (frame.type === T.Ack) {
    return `${name} seq=${frame.seq} ackSeq=${frame.payload.readUInt32BE(0)} decodeQueue=${frame.payload.readUInt16BE(4)}`;
  }
  if (frame.type === T.Input) {
    const { events } = JSON.parse(frame.payload.toString("utf8"));
    const summary = events.map(describeInputEvent).join(" ");
    return `${name} seq=${frame.seq} bytes=${frame.payload.length} ${summary}`;
  }
  if (frame.payload.length > 0) return `${name} seq=${frame.seq} ${frame.payload.toString("utf8")}`;
  return `${name} seq=${frame.seq}`;
};

const pickStream = (streams, decoders) => {
  if (streams.vp9 && decoders?.vp9) return streams.vp9;
  if (decoders?.h264) return streams.h264;
  return null;
};

const serve = (streams) => {
  const port = Number(args.port);
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  const links = new Set();
  // One session per mock process, so a reconnect reattaches to the same sessionId (contract 1.11).
  const sessionId = randomUUID();

  wss.on("connection", (ws) => {
    const link = {
      ws,
      seq: 0,
      startedAt: Date.now(),
      hidden: false,
      auIndex: 0,
      timer: null,
      helloSeen: false,
      stream: null,
      epoch: 1,
      corrupt: false
    };
    link.send = (type, payload, flags = 0, timestampUs = (Date.now() - link.startedAt) * 1000) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(encodeFrame(type, flags, link.seq, timestampUs, payload));
      link.seq = (link.seq + 1) >>> 0;
    };
    link.control = (body) => link.send(T.Control, Buffer.from(JSON.stringify(body)));
    link.jumpToKeyframe = () => {
      let i = link.auIndex;
      const { units } = link.stream;
      while (!units[i % units.length].keyframe) i += 1;
      link.auIndex = i;
    };
    let frameCount = 0;
    let lastAckAt = null;
    let maxAckGap = 0;
    const gapReport = setInterval(() => {
      if (lastAckAt !== null) console.log(`ack: max gap ${maxAckGap} ms over the last 5 s`);
      maxAckGap = 0;
    }, 5000);
    links.add(link);
    console.log("viewer connected");

    link.sendVideoConfig = () => {
      const config = { codec: link.stream.codec, width: WIDTH, height: HEIGHT, framerate: FPS, epoch: link.epoch };
      if (link.stream === streams.h264) config.format = "annexb";
      link.send(T.VideoConfig, Buffer.from(JSON.stringify(config)));
    };

    const startStream = (hello) => {
      link.stream = pickStream(streams, hello.decoders);
      if (!link.stream) {
        link.control({ kind: "error", code: "no_decoder", message: "No common live codec", fatal: true });
        ws.close(1000, "no_decoder");
        return;
      }
      const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
      link.control({
        kind: "session_ready",
        sessionId,
        expiresAt,
        inputEnabled: true,
        policy: { clipboard: "off", downloads: "block", uploads: "block" }
      });
      link.control({ kind: "time_left", secondsLeft: SESSION_SECONDS, expiresAt });
      link.sendVideoConfig();
      console.log(`sent session_ready, time_left, VIDEO_CONFIG ${link.stream.codec}`);
      link.timer = setInterval(() => {
        if (link.hidden || ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
        const { units } = link.stream;
        const unit = link.corrupt
          ? { keyframe: true, data: randomBytes(CORRUPT_FRAME_BYTES) }
          : units[link.auIndex % units.length];
        link.send(T.VideoChunk, unit.data, unit.keyframe ? FLAG_KEYFRAME : 0, Math.round((frameCount * 1e6) / FPS));
        frameCount += 1;
        link.auIndex += 1;
      }, 1000 / FPS);
    };

    const rejectProtocol = (reason) => {
      console.log(`protocol error: ${reason}, closing`);
      ws.close(1008, "protocol_error");
    };

    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        rejectProtocol("text message from viewer");
        return;
      }
      let frame;
      try {
        frame = decodeFrame(Buffer.from(data));
      } catch (err) {
        rejectProtocol(err.message);
        return;
      }
      if (!link.helloSeen && frame.type !== T.Hello) {
        rejectProtocol(`first upstream frame is ${TYPE_NAMES[frame.type]}, not HELLO`);
        return;
      }
      if (frame.payload.length > MAX_UPSTREAM_PAYLOAD) console.log(`LIMIT EXCEEDED: upstream payload ${frame.payload.length}`);
      if (frame.type === T.Ack) {
        const now = Date.now();
        if (lastAckAt !== null) maxAckGap = Math.max(maxAckGap, now - lastAckAt);
        lastAckAt = now;
        if (process.env.MOCK_LOG_ACKS) console.log(describeUpstream(frame));
        return;
      }
      console.log(describeUpstream(frame));
      if (frame.type === T.Hello) {
        link.helloSeen = true;
        startStream(JSON.parse(frame.payload.toString("utf8")));
      } else if (frame.type === T.KeyframeRequest) {
        link.jumpToKeyframe();
      } else if (frame.type === T.ControlUp) {
        const control = JSON.parse(frame.payload.toString("utf8"));
        if (control.kind === "end_session") {
          link.control({ kind: "session_ending", reason: "user_end" });
          ws.close(1000, "session ended");
        }
      }
    });

    ws.on("close", (code) => {
      clearInterval(link.timer);
      clearInterval(gapReport);
      links.delete(link);
      console.log(`viewer disconnected (${code})`);
    });
  });

  const commands = {
    hide: (l) => {
      l.hidden = true;
      l.control({ kind: "stream_hidden", reason: "login" });
    },
    "hide-policy": (l) => {
      l.hidden = true;
      l.control({ kind: "stream_hidden", reason: "policy" });
    },
    show: (l) => {
      l.hidden = false;
      l.control({ kind: "stream_shown" });
      l.jumpToKeyframe();
    },
    "input-off": (l) => l.control({ kind: "input_state", enabled: false }),
    "input-on": (l) => l.control({ kind: "input_state", enabled: true }),
    degraded: (l) => l.control({ kind: "viewer_degraded", active: true, droppedFrames: 42 }),
    recovered: (l) => l.control({ kind: "viewer_degraded", active: false, droppedFrames: 42 }),
    recloss: (l) => l.control({ kind: "recording_state", state: "loss", lostMs: 1500 }),
    end: (l) => {
      l.control({ kind: "session_ending", reason: "admin_terminated" });
      l.ws.close(1000, "session ended");
    },
    error: (l) => {
      l.control({ kind: "error", code: "runner_unavailable", message: "Mock runner failure", fatal: true });
      l.ws.close(1011, "error");
    },
    epoch: (l) => {
      l.epoch += 1;
      l.sendVideoConfig();
      l.jumpToKeyframe();
    },
    // Until the link closes, every frame is a keyframe of random bytes: a stream the probe accepted but the
    // decoder cannot decode (the viewer falls back from VP9 to H.264).
    corrupt: (l) => {
      l.corrupt = true;
    },
    drop: (l) => l.ws.terminate()
  };
  createInterface({ input: process.stdin }).on("line", (line) => {
    const command = commands[line.trim()];
    if (!command) {
      console.log(`unknown command; try: ${Object.keys(commands).join(", ")}`);
      return;
    }
    links.forEach(command);
    console.log(`command ${line.trim()} sent to ${links.size} viewer(s)`);
  });

  wss.on("listening", () => console.log(`listening on ${port}`));
};

selfCheck();
if (!args["self-check"]) serve(generateStreams());
