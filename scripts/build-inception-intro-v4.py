from pathlib import Path
import hashlib
import json
import shutil
import subprocess

repo = Path(__file__).resolve().parents[1]
cache = repo.parent / 'inception-production'
ffmpeg = shutil.which('ffmpeg') or str(repo.parent / 'media-tools' / 'imageio_ffmpeg' / 'binaries' / 'ffmpeg-win-x86_64-v7.1.exe')
legacy = cache / 'film-first75.mp4'
doors = cache / 'door-source-60-150.mp4'
closed = repo / 'static' / 'inception-assets' / 'strongroom-closed-v1.webp'
roomtone = repo / 'static' / 'inception-assets' / 'strongroom-roomtone-v1.mp3'
output = repo / 'static' / 'inception-assets' / 'strongroom-intro-v4.mp4'
captions = repo / 'static' / 'inception-assets' / 'strongroom-intro-v4.vtt'

segments = [
    (legacy, 66.25, 2.4),
    (doors, 17.5, 2.0),
    (doors, 28.5, 3.0),
    (legacy, 15.6, 10.6),
]
film_duration = sum(duration for _, _, duration in segments)
bridge_duration = 7.6
crossfade = 0.6
intro_duration = film_duration + bridge_duration - crossfade
assert abs(film_duration - 18.0) < 1e-6 and abs(intro_duration - 25.0) < 1e-6
for required in (legacy, doors, closed, roomtone):
    if not required.is_file():
        raise SystemExit(f'Required local source is missing: {required.name}')

args = [ffmpeg, '-hide_banner', '-loglevel', 'warning']
for source, start, duration in segments:
    args += ['-ss', str(start), '-t', str(duration), '-i', str(source)]
bridge_input = len(segments)
audio_input = bridge_input + 1
args += ['-loop', '1', '-framerate', '30', '-i', str(closed), '-i', str(roomtone)]

filters = []
for index, (_, _, duration) in enumerate(segments):
    filters.append(f'[{index}:v]crop=1920:800:0:140,pad=1920:1080:0:140:black,trim=duration={duration},setpts=PTS-STARTPTS,fps=30,format=yuv420p,settb=AVTB[v{index}]')
filters.append(f'[v0][v1][v2][v3]concat=n=4:v=1:a=0[film]')
filters.append(f'[{bridge_input}:v]scale=1920:1080:flags=lanczos,trim=duration={bridge_duration},setpts=PTS-STARTPTS,fps=30,format=yuv420p,settb=AVTB[bridge]')
filters.append(f'[film][bridge]xfade=transition=fadeblack:duration={crossfade}:offset={film_duration-crossfade},trim=duration={intro_duration},format=yuv420p[v]')
for index, (_, _, duration) in enumerate(segments):
    filters.append(f'[{index}:a]atrim=duration={duration},asetpts=PTS-STARTPTS,aresample=48000[a{index}]')
filters.append('[a0][a1][a2][a3]concat=n=4:v=0:a=1[afilm0]')
filters.append(f'[afilm0]afade=t=out:st={film_duration-0.75}:d=0.75[afilm]')
filters.append(f'[{audio_input}:a]atrim=duration={bridge_duration},asetpts=PTS-STARTPTS,aresample=48000,volume=0.8[aroom]')
filters.append(f'[afilm][aroom]acrossfade=d={crossfade}:c1=tri:c2=tri,atrim=duration={intro_duration}[a]')
args += [
    '-filter_complex_threads', '2', '-filter_complex', ';'.join(filters),
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '21',
    '-maxrate', '4000k', '-bufsize', '8000k', '-threads', '2', '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', '-map_metadata', '-1', '-metadata', 'title=The strongroom - Eames and Fischer',
    '-t', str(intro_duration), '-y', str(output),
]
log = cache / 'intro-v4-encode.log'
with log.open('w', encoding='utf-8') as handle:
    result = subprocess.run(args, stdout=subprocess.DEVNULL, stderr=handle)
if result.returncode:
    raise SystemExit(f'Intro v4 encoding failed with exit code {result.returncode}; see the ignored local log.')

captions.write_text('''WEBVTT

00:00.000 --> 00:02.400
You are Eames.

00:02.400 --> 00:07.400
Fischer enters the strongroom.

00:07.400 --> 00:12.000
His father is waiting inside the dream.

00:12.000 --> 00:17.400
In this encounter, he cannot remember the combination.

00:18.100 --> 00:21.600
The answer belongs to an earlier memory.

00:21.600 --> 00:25.000
Help him remember before the dream collapses.
''', encoding='utf-8')

for file in (output, captions):
    data = file.read_bytes()
    print(json.dumps({'file': file.name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}))
