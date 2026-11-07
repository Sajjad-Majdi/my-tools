// File preparation for send_file (2026-10-26: videos, photos, markdown and every other file must arrive right,
// videos with preview and duration). GramJS alone sends a video as duration 0, 1x1 px, no thumbnail, and a non-faststart
// or non-H.264 file does not play inline. Here ffprobe reads the real metadata, ffmpeg makes an mp4 Telegram can stream
// (remux when the codecs fit, else H.264/AAC) and a 320 px JPEG preview; audio and voice notes get their duration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const LINKS = path.join(os.homedir(), "AppData", "Local", "Microsoft", "WinGet", "Links"); // winget's ffmpeg
const bin = (name) => (fs.existsSync(path.join(LINKS, name + ".exe")) ? path.join(LINKS, name + ".exe") : name);
const FFPROBE = bin("ffprobe");
const FFMPEG = bin("ffmpeg");
const run = (cmd, args, timeout) => exec(cmd, args, { timeout, windowsHide: true, maxBuffer: 16 << 20 });

export const PHOTO_EXT = /\.(jpe?g|png)$/i; // what Telegram takes as a compressed photo (GramJS isImage)
export const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|3gp|mpg|mpeg|ts|mts)$/i;
export const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|wma)$/i;
const PLAYS_VIDEO = new Set(["h264", "hevc"]); // inline playback on every Telegram client
const PLAYS_AUDIO = new Set(["aac", "mp3"]);
const MAX_TRANSCODE_S = 3600; // longer non-H.264 videos go as they are (CPU time)

export async function probe(file) {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], 60_000);
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = (j.streams || []).find((s) => s.codec_type === "audio");
  let w = v?.width, h = v?.height;
  const rot = Number(v?.tags?.rotate ?? v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0);
  if (Math.abs(rot) % 180 === 90) [w, h] = [h, w]; // phone videos: Telegram needs the display size
  return {
    duration: Number(j.format?.duration || v?.duration || a?.duration || 0),
    w, h, vcodec: v?.codec_name, acodec: a?.codec_name, format: j.format?.format_name || "",
    title: j.format?.tags?.title, artist: j.format?.tags?.artist,
  };
}

// moov before mdat at the top level = Telegram can play it before the whole file is downloaded
export function isFaststart(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(16);
    let pos = 0;
    for (let i = 0; i < 64 && pos + 8 <= size; i++) {
      fs.readSync(fd, buf, 0, 16, pos);
      let len = buf.readUInt32BE(0);
      const type = buf.toString("latin1", 4, 8);
      if (type === "moov") return true;
      if (type === "mdat") return false;
      if (len === 1) len = Number(buf.readBigUInt64BE(8));
      if (len < 8) return false;
      pos += len;
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

export async function prepareVideo(file, tmp) {
  const m = await probe(file);
  if (!m.w) return { file, meta: m };
  const vOk = PLAYS_VIDEO.has(m.vcodec);
  const aOk = !m.acodec || PLAYS_AUDIO.has(m.acodec);
  const mp4 = /mp4|mov/.test(m.format) && /\.(mp4|m4v|mov)$/i.test(file);
  let out = file;
  let did;
  if (!(vOk && aOk && mp4 && isFaststart(file)) && (vOk || m.duration <= MAX_TRANSCODE_S)) {
    out = path.join(tmp, path.parse(file).name + ".mp4");
    const args = ["-v", "error", "-y", "-i", file, "-map", "0:v:0", "-map", "0:a:0?", "-dn", "-sn"];
    args.push(...(vOk ? ["-c:v", "copy"] : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p"]));
    args.push(...(aOk ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "160k"]));
    if (vOk && m.vcodec === "hevc") args.push("-tag:v", "hvc1");
    args.push("-movflags", "+faststart", out);
    await run(FFMPEG, args, 25 * 60_000);
    did = vOk && aOk ? "remuxed to mp4 (faststart)" : !vOk ? `converted ${m.vcodec} to H.264` : `converted ${m.acodec} audio to AAC`;
  }
  const thumb = path.join(tmp, "thumb.jpg");
  const at = m.duration > 3 ? Math.min(m.duration * 0.1, 5) : 0;
  try {
    await run(FFMPEG, ["-v", "error", "-y", "-ss", String(at), "-i", out, "-frames:v", "1",
      "-vf", "scale=320:320:force_original_aspect_ratio=decrease", "-q:v", "5", thumb], 60_000);
  } catch {}
  return { file: out, meta: m, thumb: fs.existsSync(thumb) ? thumb : undefined, did };
}

// voice notes must be OGG/Opus; anything else is converted (mono 48 kbit/s, like the Telegram apps)
export async function prepareVoice(file, tmp) {
  const m = await probe(file);
  if (m.acodec === "opus" && /ogg/.test(m.format)) return { file, meta: m };
  const out = path.join(tmp, path.parse(file).name + ".ogg");
  await run(FFMPEG, ["-v", "error", "-y", "-i", file, "-vn", "-c:a", "libopus", "-b:a", "48k", "-ac", "1", out], 10 * 60_000);
  return { file: out, meta: m, did: "converted to OGG/Opus voice" };
}
