#!/usr/bin/env python3
"""Generate numerical YUV fixtures, encode as hardware-decodable H.264/HLS.

Run from the repository root with Python 3 and ffmpeg on PATH. Output is derived
test data under dist/video-transfer-slate; the encoded pixels contain no labels.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dist" / "video-transfer-slate"
WIDTH, HEIGHT = 512, 256
FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
if not FFMPEG or not FFPROBE:
    raise SystemExit("ffmpeg and ffprobe are required on PATH")
OUT.mkdir(parents=True, exist_ok=True)


def run(*args):
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *map(str, args)], check=True)


y_plane = bytearray(WIDTH * HEIGHT)
u_plane = bytearray([128] * (WIDTH * HEIGHT // 4))
v_plane = bytearray(u_plane)
for y in range(HEIGHT):
    for x in range(WIDTH):
        # A full code sweep tests footroom and headroom as well as nominal range.
        y_plane[y * WIDTH + x] = x // 2 if y < 64 else 16 + x // 16 if y < 128 else 128
for cy in range(HEIGHT // 2):
    for cx in range(WIDTH // 2):
        i = cy * (WIDTH // 2) + cx
        if 64 <= cy < 96:
            # Constant luma and Cr; Cb transitions at several spatial frequencies.
            period = (1, 4, 16, 32)[cx // 64]
            u_plane[i] = 96 if (cx // period) % 2 == 0 else 160
        elif cy >= 96:
            # Constant luma and Cb; horizontal Cr edges, including one chroma row.
            period = (1, 2, 4, 8)[cx // 64]
            v_plane[i] = 96 if ((cy - 96) // period) % 2 == 0 else 160

raw = bytes(y_plane + u_plane + v_plane)
raw_path = OUT / "source.yuv"
raw_path.write_bytes(raw)
manifest = {
    "width": WIDTH, "height": HEIGHT, "format": "yuv420p", "range": "limited",
    "matrix": "bt709", "primaries": "bt709", "durationSeconds": 2,
    "panels": [
        {"name": "neutral code sweep", "y": [0, 64], "Y": "floor(x/2)", "Cb": 128, "Cr": 128},
        {"name": "shadow staircase", "y": [64, 128], "Y": "16+floor(x/16)", "Cb": 128, "Cr": 128},
        {"name": "vertical Cb edges", "y": [128, 192], "Y": 128, "Cb": [96, 160], "Cr": 128},
        {"name": "horizontal Cr edges", "y": [192, 256], "Y": 128, "Cb": 128, "Cr": [96, 160]},
    ],
    "encoder": "libx264, high profile, QP 1, yuv420p; decoded planes are checked below",
    "files": {}, "decodedErrors": {}, "encodedMetadata": {},
}
decoded_variants = []
for transfer in ("bt709", "iec61966-2-1"):
    stem = "bt709" if transfer == "bt709" else "srgb"
    mp4 = OUT / f"{stem}.mp4"
    run("-stream_loop", "-1", "-f", "rawvideo", "-pixel_format", "yuv420p",
        "-video_size", f"{WIDTH}x{HEIGHT}", "-framerate", "30",
        "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709",
        "-color_trc", transfer, "-i", raw_path,
        "-t", "2", "-an", "-c:v", "libx264", "-profile:v", "high", "-qp", "1",
        "-g", "30", "-keyint_min", "30", "-sc_threshold", "0", "-bf", "0",
        "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709",
        "-color_trc", transfer, "-movflags", "+faststart", mp4)
    run("-i", mp4, "-c", "copy", "-hls_time", "1", "-hls_list_size", "0",
        "-hls_segment_filename", OUT / f"{stem}-%02d.ts", OUT / f"{stem}.m3u8")
    decoded_path = OUT / f"{stem}-decoded.yuv"
    run("-i", mp4, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "yuv420p", decoded_path)
    decoded = decoded_path.read_bytes()
    if len(decoded) != len(raw):
        raise RuntimeError("Decoded frame size differs from the reference")
    decoded_variants.append(decoded)
    diff = [abs(a - b) for a, b in zip(raw, decoded)]
    manifest["decodedErrors"][stem] = {"maxCodeError": max(diff), "changedBytes": sum(d != 0 for d in diff)}
    if any(diff):
        raise RuntimeError(f"{stem}: encoded pixels changed; cannot use this fixture as an exact reference")
    info = json.loads(subprocess.check_output([FFPROBE, "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=profile,pix_fmt,color_range,color_space,color_transfer,color_primaries",
        "-of", "json", str(mp4)], text=True))["streams"][0]
    manifest["encodedMetadata"][stem] = info
    expected = {"pix_fmt": "yuv420p", "color_range": "tv", "color_space": "bt709",
                "color_transfer": transfer, "color_primaries": "bt709"}
    if any(info.get(key) != value for key, value in expected.items()):
        raise RuntimeError(f"{stem}: incorrect encoded color metadata: {info}")

manifest["decodedVariantsIdentical"] = decoded_variants[0] == decoded_variants[1]
run("-i", OUT / "bt709.mp4", "-frames:v", "1", OUT / "preview.png")
for path in sorted(OUT.iterdir()):
    if path.name != "manifest.json" and path.is_file():
        manifest["files"][path.name] = {"bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps({"output": str(OUT), "decodedErrors": manifest["decodedErrors"],
                  "decodedVariantsIdentical": manifest["decodedVariantsIdentical"]}, indent=2))
