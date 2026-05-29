#!/usr/bin/env python3
"""Slim KayKit Skeleton GLBs to only the animation clips the game uses.

~85-89% of each 4.8MB skeleton GLB is animation data for 95 clips, of which the
game wires up only a handful (idle/run/attack/hit/death). Parsing 19MB of cold
GLB at the first wave stalled the main thread so most enemies never finished the
SkeletonUtils.clone() upgrade ("skeletons = 1 of 8") and the cold parse tanked
FPS. This drops the unused clips and repacks the binary chunk (garbage-collecting
the now-orphaned bufferViews/accessors), keeping the file SELF-CONTAINED: the
single embedded texture/atlas stays inline, no external .bin/.png/.jpg is ever
introduced. Mesh/skin/skeleton data is untouched, so the look is identical.

Deterministic, no network, no third-party deps.
"""
import json
import struct
import sys
import os

# Clips the runtime references (CLIP_CANDIDATES in js/enemies.js) plus their
# *_Pose / resurrect siblings are NOT needed. Keep exactly the candidates.
KEEP = {
    'Idle', 'Idle_Combat', 'Idle_B', 'Unarmed_Idle',
    'Running_A', 'Running_B', 'Running_C', 'Walking_A', 'Walking_B',
    '1H_Melee_Attack_Chop', '2H_Melee_Attack_Chop', 'Unarmed_Melee_Attack_Punch_A',
    'Hit_A', 'Hit_B', 'Block_Hit',
    'Death_A', 'Death_B', 'Death_C_Skeletons',
}

GLB_MAGIC = 0x46546C67
JSON_TYPE = 0x4E4F534A
BIN_TYPE = 0x004E4942


def read_glb(path):
    with open(path, 'rb') as f:
        magic, version, total = struct.unpack('<III', f.read(12))
        assert magic == GLB_MAGIC, 'not a GLB'
        json_chunk = None
        bin_chunk = b''
        while f.tell() < total:
            clen, ctype = struct.unpack('<II', f.read(8))
            data = f.read(clen)
            if ctype == JSON_TYPE:
                json_chunk = json.loads(data)
            elif ctype == BIN_TYPE:
                bin_chunk = data
        return json_chunk, bin_chunk


def slim(j, bin_data):
    # 1) Keep only wanted animations.
    j['animations'] = [a for a in j.get('animations', []) if a.get('name') in KEEP]

    # 2) Find every accessor still referenced anywhere AFTER pruning anims.
    used_acc = set()

    def use(idx):
        if idx is not None:
            used_acc.add(idx)

    for m in j.get('meshes', []):
        for p in m.get('primitives', []):
            for v in p.get('attributes', {}).values():
                use(v)
            use(p.get('indices'))
            for tgt in p.get('targets', []) or []:
                for v in tgt.values():
                    use(v)
    for s in j.get('skins', []):
        use(s.get('inverseBindMatrices'))
    for a in j.get('animations', []):
        for samp in a.get('samplers', []):
            use(samp.get('input'))
            use(samp.get('output'))

    # Accessors can reference each other only via sparse indices (own bufferViews),
    # not other accessors, so the set above is complete. Now compute which
    # bufferViews are referenced by surviving accessors OR by images.
    accessors = j.get('accessors', [])
    bufferViews = j.get('bufferViews', [])

    used_bv = set()
    for ai in used_acc:
        acc = accessors[ai]
        if acc.get('bufferView') is not None:
            used_bv.add(acc['bufferView'])
        sparse = acc.get('sparse')
        if sparse:
            used_bv.add(sparse['indices']['bufferView'])
            used_bv.add(sparse['values']['bufferView'])
    for img in j.get('images', []):
        if img.get('bufferView') is not None:
            used_bv.add(img['bufferView'])

    # 3) Repack the binary: copy only used bufferViews into a fresh buffer,
    #    4-byte aligned, and rewrite their byteOffset/byteLength.
    bv_remap = {idx: i for i, idx in enumerate(sorted(used_bv))}
    new_bvs = [None] * len(bv_remap)
    new_bin = bytearray()
    for old_idx in sorted(used_bv):
        bv = bufferViews[old_idx]
        off = bv.get('byteOffset', 0)
        ln = bv['byteLength']
        chunk = bin_data[off:off + ln]
        while len(new_bin) % 4 != 0:
            new_bin.append(0)
        new_off = len(new_bin)
        new_bin.extend(chunk)
        nb = {'buffer': 0, 'byteOffset': new_off, 'byteLength': ln}
        if 'byteStride' in bv:
            nb['byteStride'] = bv['byteStride']
        if 'target' in bv:
            nb['target'] = bv['target']
        if 'name' in bv:
            nb['name'] = bv['name']
        new_bvs[bv_remap[old_idx]] = nb

    j['bufferViews'] = new_bvs

    # 4) Rewrite every accessor's bufferView reference (keep ALL accessors so we
    #    don't have to reindex meshes/skins/anims; only used ones survive anim
    #    pruning's reachability, but unused accessors with a now-dropped
    #    bufferView would dangle). Drop accessors whose bufferView was dropped
    #    AND that are unused; remap reachable ones.
    # Simpler + safe: reindex accessors too.
    acc_remap = {}
    new_accs = []
    for ai in sorted(used_acc):
        acc_remap[ai] = len(new_accs)
        acc = dict(accessors[ai])
        if acc.get('bufferView') is not None:
            acc['bufferView'] = bv_remap[acc['bufferView']]
        if 'sparse' in acc:
            sp = json.loads(json.dumps(acc['sparse']))
            sp['indices']['bufferView'] = bv_remap[sp['indices']['bufferView']]
            sp['values']['bufferView'] = bv_remap[sp['values']['bufferView']]
            acc['sparse'] = sp
        new_accs.append(acc)
    j['accessors'] = new_accs

    # remap accessor refs everywhere
    def racc(idx):
        return acc_remap[idx]

    for m in j.get('meshes', []):
        for p in m.get('primitives', []):
            p['attributes'] = {k: racc(v) for k, v in p['attributes'].items()}
            if p.get('indices') is not None:
                p['indices'] = racc(p['indices'])
            if p.get('targets'):
                p['targets'] = [{k: racc(v) for k, v in t.items()} for t in p['targets']]
    for s in j.get('skins', []):
        if s.get('inverseBindMatrices') is not None:
            s['inverseBindMatrices'] = racc(s['inverseBindMatrices'])
    for a in j.get('animations', []):
        for samp in a.get('samplers', []):
            samp['input'] = racc(samp['input'])
            samp['output'] = racc(samp['output'])

    # remap image bufferViews
    for img in j.get('images', []):
        if img.get('bufferView') is not None:
            img['bufferView'] = bv_remap[img['bufferView']]

    # 5) Fix buffer length.
    if j.get('buffers'):
        j['buffers'][0] = {'byteLength': len(new_bin)}
    return j, bytes(new_bin)


def write_glb(path, j, bin_data):
    json_bytes = json.dumps(j, separators=(',', ':')).encode('utf-8')
    while len(json_bytes) % 4 != 0:
        json_bytes += b' '
    bin_padded = bytearray(bin_data)
    while len(bin_padded) % 4 != 0:
        bin_padded.append(0)
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_padded)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', GLB_MAGIC, 2, total))
        f.write(struct.pack('<II', len(json_bytes), JSON_TYPE))
        f.write(json_bytes)
        f.write(struct.pack('<II', len(bin_padded), BIN_TYPE))
        f.write(bin_padded)


def main():
    files = sys.argv[1:]
    for path in files:
        j, b = read_glb(path)
        before = os.path.getsize(path)
        kept = [a['name'] for a in j.get('animations', []) if a.get('name') in KEEP]
        j2, b2 = slim(j, b)
        write_glb(path, j2, b2)
        after = os.path.getsize(path)
        print(f'{os.path.basename(path)}: {before} -> {after} bytes, clips kept={len(kept)} {kept}')


if __name__ == '__main__':
    main()
