#!/usr/bin/env node
// Dev-only mock of the gateway side of the Web App viewer link (CONTRACTS.md section 1), so the viewer can be driven
// without the backend, gateway and runner.
//
//   node scripts/pam-web-app-mock-stream.mjs [--port 7104] [--input <video file>] [--self-check]
//
// The app CSP only allows same-origin WebSockets, so proxy a path of the dev server to the mock, for example in a
// local (uncommitted) vite config: server.proxy["/pam-web-app-mock"] = { target: "ws://127.0.0.1:7104", ws: true }.
// Then, in the browser console of the dev build:
//   localStorage.setItem("pam-web-app:mock-ws-url", "/pam-web-app-mock")
// and open any PAM account's access page. Remove the key to go back to the real flow.
//
// The video is re-encoded once with ffmpeg into H.264 Annex B (keyint 30, AUD NALs, SPS/PPS before every IDR), so
// access units split on AUDs and keyframe recovery is quick. Upstream frames are logged. Commands on stdin:
//   hide | show | input-off | input-on | degraded | recovered | recloss | end | error | drop
//
// The 20-byte header is encoded here because Node cannot import the TypeScript contract module directly; the
// encoder is checked against the contract test vectors at startup.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
const FPS = 30;

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
  vectors.forEach((v) => {
    const frame = encodeFrame(v.type, v.flags, v.seq, v.timestampUs, Buffer.from(v.payloadHex, "hex"));
    if (frame.toString("hex") !== v.frameHex) throw new Error(`header self-check failed for ${v.name}`);
  });
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
  findStartCodes(data).forEach(({ at, nal }) => {
    const nalType = data[nal] & 0x1f;
    if (nalType === 9) {
      if (current) units.push(current);
      current = { start: at, keyframe: false };
    }
    if (nalType === 5 && current) current.keyframe = true;
    if (nalType === 7 && !codec) {
      codec = `avc1.${[data[nal + 1], data[nal + 2], data[nal + 3]]
        .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
        .join("")}`;
    }
  });
  if (current) units.push(current);
  return {
    codec,
    units: units.map((unit, i) => ({
      keyframe: unit.keyframe,
      data: data.subarray(unit.start, i + 1 < units.length ? units[i + 1].start : data.length)
    }))
  };
};

const generateStream = () => {
  const dir = mkdtempSync(join(tmpdir(), "pam-web-app-mock-"));
  const out = join(dir, "live.h264");
  const input = args.input ?? DEFAULT_INPUT;
  const source = existsSync(input)
    ? ["-i", input]
    : ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=10"];
  // The moving square guarantees visible change even when the recording is mostly static.
  const result = spawnSync(
    "ffmpeg",
    [
      "-v", "error", "-y", ...source, "-an",
      "-filter_complex", "color=c=red:s=32x32[b];[0:v][b]overlay=x='mod(n*12,1240)':y=8:shortest=1,fps=30,format=yuv420p",
      "-c:v", "libx264", "-profile:v", "baseline", "-level", "3.1", "-preset", "veryfast", "-tune", "zerolatency",
      "-x264-params", "keyint=30:min-keyint=30:scenecut=0:repeat-headers=1:aud=1",
      "-bsf:v", "h264_mp4toannexb", "-f", "h264", out
    ],
    { stdio: ["ignore", "inherit", "inherit"] }
  );
  if (result.status !== 0) throw new Error(`ffmpeg failed with status ${result.status}`);
  const data = readFileSync(out);
  rmSync(dir, { recursive: true, force: true });
  const stream = splitAccessUnits(data);
  if (!stream.codec || stream.units.length === 0 || !stream.units[0].keyframe) {
    throw new Error("generated stream has no SPS or does not start with a keyframe");
  }
  console.log(
    `stream ready: ${stream.units.length} access units, ${stream.units.filter((u) => u.keyframe).length} keyframes, codec ${stream.codec}, source ${existsSync(input) ? input : "testsrc2"}`
  );
  return stream;
};

const describeUpstream = (frame) => {
  const name = TYPE_NAMES[frame.type] ?? `0x${frame.type.toString(16)}`;
  if (frame.type === T.Ack) {
    return `${name} seq=${frame.seq} ackSeq=${frame.payload.readUInt32BE(0)} decodeQueue=${frame.payload.readUInt16BE(4)}`;
  }
  if (frame.type === T.Input) {
    const { events } = JSON.parse(frame.payload.toString("utf8"));
    const summary = events
      .map((e) => {
        if (e.t === "key") return `key:${e.action}:${e.code}:${e.key}:m${e.mods}`;
        if (e.t === "move") return `move:${e.x},${e.y}:b${e.buttons}`;
        if (e.t === "button") return `button:${e.action}:${e.button}@${e.x},${e.y}`;
        if (e.t === "wheel") return `wheel:${e.dx},${e.dy}@${e.x},${e.y}`;
        if (e.t === "ime") return `ime:${JSON.stringify(e.text)}`;
        if (e.t === "paste") return `paste:${e.id}:${e.part + 1}/${e.total}:${e.text.length}ch`;
        return e.t;
      })
      .join(" ");
    return `${name} seq=${frame.seq} bytes=${frame.payload.length} ${summary}`;
  }
  if (frame.payload.length > 0) return `${name} seq=${frame.seq} ${frame.payload.toString("utf8")}`;
  return `${name} seq=${frame.seq}`;
};

const serve = (stream) => {
  const port = Number(args.port);
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  const links = new Set();

  wss.on("connection", (ws) => {
    const link = { ws, seq: 0, startedAt: Date.now(), hidden: false, auIndex: 0, timer: null, helloSeen: false };
    link.send = (type, payload, flags = 0, timestampUs = (Date.now() - link.startedAt) * 1000) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(encodeFrame(type, flags, link.seq, timestampUs, payload));
      link.seq = (link.seq + 1) >>> 0;
    };
    link.control = (body) => link.send(T.Control, Buffer.from(JSON.stringify(body)));
    link.jumpToKeyframe = () => {
      let i = link.auIndex;
      while (!stream.units[i % stream.units.length].keyframe) i += 1;
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

    const startStream = () => {
      const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
      link.control({
        kind: "session_ready",
        sessionId: randomUUID(),
        expiresAt,
        inputEnabled: true,
        policy: { clipboard: "off", downloads: "block", uploads: "block" }
      });
      link.control({ kind: "time_left", secondsLeft: 3600, expiresAt });
      link.send(
        T.VideoConfig,
        Buffer.from(
          JSON.stringify({ codec: stream.codec, format: "annexb", width: 1280, height: 720, framerate: FPS, epoch: 1 })
        )
      );
      console.log(`sent session_ready, time_left, VIDEO_CONFIG ${stream.codec}`);
      link.timer = setInterval(() => {
        if (link.hidden || ws.bufferedAmount > 2 * 1024 * 1024) return;
        const unit = stream.units[link.auIndex % stream.units.length];
        link.send(T.VideoChunk, unit.data, unit.keyframe ? 1 : 0, Math.round((frameCount * 1e6) / FPS));
        frameCount += 1;
        link.auIndex += 1;
      }, 1000 / FPS);
    };

    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        console.log("protocol error: text message from viewer, closing");
        ws.close(1008, "protocol_error");
        return;
      }
      let frame;
      try {
        frame = decodeFrame(Buffer.from(data));
      } catch (err) {
        console.log(`protocol error: ${err.message}, closing`);
        ws.close(1008, "protocol_error");
        return;
      }
      if (!link.helloSeen && frame.type !== T.Hello) {
        console.log(`protocol error: first upstream frame is ${TYPE_NAMES[frame.type]}, not HELLO`);
        ws.close(1008, "protocol_error");
        return;
      }
      if (frame.payload.length > 61440) console.log(`LIMIT EXCEEDED: upstream payload ${frame.payload.length}`);
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
        startStream();
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
if (!args["self-check"]) serve(generateStream());
