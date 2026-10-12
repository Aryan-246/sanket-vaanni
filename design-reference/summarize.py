import json

with open(r'c:\PROJECT\SANKET VAANNI\design-reference\evaluation_output\evaluation_report.json') as f:
    data = json.load(f)

for k, d in data.items():
    print('='*60)
    print('MODEL:', k)
    print('Objects:', [o['name'] + ' (' + o['type'] + ')' for o in d['objects']])
    for m in d['meshes']:
        print(f"Mesh: {m['mesh_name']} | Verts: {m['vertex_count']} | Polys: {m['polygon_count']} | Tris: {m['triangles']} | Quads: {m['quads']}")
        print(f"Dimensions (m): {m['dimensions_meters']}")
        print(f"Vertex groups: {len(m['vertex_groups'])} | Unweighted verts: {m['unweighted_vertices']}")
        print("Vertex groups list:", m['vertex_groups'])
    for a in d['armatures']:
        print(f"Armature: {a['armature_name']} | Total Bones: {a['bone_count']}")
        print(f"Root bones: {a['root_bones']}")
        all_bones = list(a['bones'].keys())
        print(f"All bones ({len(all_bones)}):", all_bones)
    print('Actions (Animations):', d['actions'])
    print('Materials:', [mat['name'] for mat in d['materials']])
    print('GLTF Export:', d['gltf_export'])
