#!/usr/bin/env python3
"""D10.0.1 packaging answer: the DLL closure a shipped GStreamer helper would need.

Walks PE import tables (normal + delay-load) from a seed set of plugin DLLs, resolving names against the
portable runtime's bin/ and lib/gstreamer-1.0/, and prints the set with sizes. No dependencies (no dumpbin on
the dev machine). Run with -I:  python -I dllset.py [--root <msvc_x86_64>] [--seeds a,b,c]
Note: NVENC/NVDEC (nvEncodeAPI64.dll, nvcuvid.dll, nvcuda.dll) come from the driver and are not in the tree.
"""
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ROOT = os.path.join(HERE, '..', 'deps', 'gstreamer', '1.0', 'msvc_x86_64')
# Sender: coreelements (queue, capsfilter) app nvcodec x264 videoparsersbad (h264parse) rtp rtpmanager webrtc nice
# dtls srtp rswebrtc (whipclientsink) rsrtp (rtpgccbwe) videoconvertscale videorate (webrtcsink inserts them).
# Receiver adds playback (decodebin3/parsebin) typefindfunctions d3d11 d3d12 libav (avdec_h264 fallback).
SENDER = ['gstcoreelements', 'gstapp', 'gstnvcodec', 'gstx264', 'gstvideoparsersbad', 'gstrtp', 'gstrtpmanager',
          'gstwebrtc', 'gstnice', 'gstdtls', 'gstsrtp', 'gstrswebrtc', 'gstrsrtp', 'gstvideoconvertscale', 'gstvideorate']
RECEIVER = ['gstplayback', 'gsttypefindfunctions', 'gstd3d11', 'gstd3d12', 'gstlibav']


def imports(path):
    with open(path, 'rb') as f:
        data = f.read()
    if data[:2] != b'MZ':
        return []
    pe = struct.unpack_from('<I', data, 0x3c)[0]
    if data[pe:pe + 4] != b'PE\0\0':
        return []
    nsec = struct.unpack_from('<H', data, pe + 6)[0]
    opt = pe + 24
    magic = struct.unpack_from('<H', data, opt)[0]
    ddir = opt + (112 if magic == 0x20b else 96)
    ndirs = struct.unpack_from('<I', data, ddir - 4)[0]
    secs = []
    so = opt + struct.unpack_from('<H', data, pe + 20)[0]
    for i in range(nsec):
        s = so + 40 * i
        vsize, va, rsize, raw = struct.unpack_from('<IIII', data, s + 8)
        secs.append((va, max(vsize, rsize), raw))

    def off(rva):
        for va, size, raw in secs:
            if va <= rva < va + size:
                return raw + rva - va
        return None

    def cstr(rva):
        o = off(rva)
        if o is None:
            return None
        return data[o:data.index(b'\0', o)].decode('ascii', 'replace')

    names = []
    if ndirs > 1:
        rva, size = struct.unpack_from('<II', data, ddir + 8 * 1)
        o = off(rva) if rva else None
        while o is not None:
            name_rva = struct.unpack_from('<I', data, o + 12)[0]
            if not name_rva:
                break
            names.append(cstr(name_rva))
            o += 20
    if ndirs > 13:
        rva, size = struct.unpack_from('<II', data, ddir + 8 * 13)
        o = off(rva) if rva else None
        while o is not None:
            attrs, name_rva = struct.unpack_from('<II', data, o)
            if not name_rva:
                break
            names.append(cstr(name_rva))
            o += 32
    return [n for n in names if n]


def main():
    args = sys.argv[1:]
    root = os.path.abspath(args[args.index('--root') + 1] if '--root' in args else DEFAULT_ROOT)
    seeds = args[args.index('--seeds') + 1].split(',') if '--seeds' in args else SENDER + RECEIVER
    bindir, plugdir = os.path.join(root, 'bin'), os.path.join(root, 'lib', 'gstreamer-1.0')
    index = {}
    for d in (bindir, plugdir):
        for f in os.listdir(d):
            if f.lower().endswith('.dll'):
                index[f.lower()] = os.path.join(d, f)
    todo = [index[s.lower() + '.dll'] for s in seeds if s.lower() + '.dll' in index]
    missing = [s for s in seeds if s.lower() + '.dll' not in index]
    seen, external = {}, set()
    while todo:
        p = todo.pop()
        if p in seen:
            continue
        seen[p] = os.path.getsize(p)
        for n in imports(p):
            q = index.get(n.lower())
            if q:
                todo.append(q)
            else:
                external.add(n.lower())
    core = {p: s for p, s in seen.items() if os.path.dirname(p) == bindir}
    plugs = {p: s for p, s in seen.items() if os.path.dirname(p) == plugdir}
    for title, group in (('core/dep DLLs (bin/)', core), ('plugins (lib/gstreamer-1.0/)', plugs)):
        print(f'== {title}: {len(group)} files, {sum(group.values()) / 1048576:.1f} MB')
        for p, s in sorted(group.items(), key=lambda kv: -kv[1]):
            print(f'  {s / 1048576:7.2f} MB  {os.path.basename(p)}')
    print(f'== total: {len(seen)} files, {sum(seen.values()) / 1048576:.1f} MB')
    print('== system/driver DLLs (not shipped):', ' '.join(sorted(external)))
    if missing:
        print('== seeds not found:', ' '.join(missing))


if __name__ == '__main__':
    main()
