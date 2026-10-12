import bpy
import os
import sys
import json
import math
from mathutils import Vector, Euler, Matrix

def reset_blend():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def analyze_fbx(fbx_path, texture_path, output_dir, label):
    print(f"\n=======================================================")
    print(f"ANALYZING: {label}")
    print(f"FBX Path: {fbx_path}")
    print(f"Texture Path: {texture_path}")
    print(f"=======================================================\n")
    
    reset_blend()
    
    # Import FBX
    try:
        bpy.ops.import_scene.fbx(filepath=fbx_path)
    except Exception as e:
        return {"error": f"Failed to import FBX: {e}"}
        
    report = {
        "label": label,
        "fbx_path": fbx_path,
        "fbx_size_bytes": os.path.getsize(fbx_path),
        "texture_path": texture_path,
        "texture_size_bytes": os.path.getsize(texture_path) if os.path.exists(texture_path) else 0,
        "objects": [],
        "meshes": [],
        "armatures": [],
        "materials": [],
        "actions": [],
    }

    # Inspect all objects
    for obj in bpy.data.objects:
        obj_info = {
            "name": obj.name,
            "type": obj.type,
            "location": list(obj.location),
            "rotation_euler": [math.degrees(a) for a in obj.rotation_euler],
            "scale": list(obj.scale),
            "dimensions": list(obj.dimensions),
            "parent": obj.parent.name if obj.parent else None
        }
        report["objects"].append(obj_info)

    # Inspect meshes
    for obj in bpy.data.objects:
        if obj.type == 'MESH':
            mesh = obj.data
            
            # Check topology
            tri_count = 0
            quad_count = 0
            ngon_count = 0
            for poly in mesh.polygons:
                v_count = len(poly.vertices)
                if v_count == 3:
                    tri_count += 1
                elif v_count == 4:
                    quad_count += 1
                else:
                    ngon_count += 1
                    
            # Check UV layers
            uv_layers = [uv.name for uv in mesh.uv_layers]
            
            # Check Vertex Groups (skin weights)
            vg_names = [vg.name for vg in obj.vertex_groups]
            
            # Check weight distribution
            unweighted_verts = 0
            max_weights_per_vert = 0
            for v in mesh.vertices:
                g_count = len(v.groups)
                if g_count > max_weights_per_vert:
                    max_weights_per_vert = g_count
                total_w = sum(g.weight for g in v.groups)
                if total_w < 0.001:
                    unweighted_verts += 1
                    
            # Check modifiers (Armature modifier?)
            modifiers = [{"name": m.name, "type": m.type} for m in obj.modifiers]
            
            mesh_info = {
                "object_name": obj.name,
                "mesh_name": mesh.name,
                "vertex_count": len(mesh.vertices),
                "polygon_count": len(mesh.polygons),
                "triangles": tri_count,
                "quads": quad_count,
                "ngons": ngon_count,
                "dimensions_meters": list(obj.dimensions),
                "uv_layers": uv_layers,
                "vertex_group_count": len(vg_names),
                "vertex_groups": vg_names,
                "unweighted_vertices": unweighted_verts,
                "max_weights_per_vertex": max_weights_per_vert,
                "modifiers": modifiers,
                "materials": [mat.name if mat else None for mat in obj.data.materials]
            }
            report["meshes"].append(mesh_info)

    # Inspect Armatures
    for obj in bpy.data.objects:
        if obj.type == 'ARMATURE':
            arm = obj.data
            bones_info = {}
            root_bones = []
            
            for b in arm.bones:
                bones_info[b.name] = {
                    "parent": b.parent.name if b.parent else None,
                    "children": [c.name for c in b.children],
                    "length": b.length,
                    "head": list(b.head),
                    "tail": list(b.tail)
                }
                if not b.parent:
                    root_bones.append(b.name)
                    
            arm_info = {
                "object_name": obj.name,
                "armature_name": arm.name,
                "bone_count": len(arm.bones),
                "root_bones": root_bones,
                "bones": bones_info
            }
            report["armatures"].append(arm_info)

    # Inspect Actions (Animations)
    for action in bpy.data.actions:
        frame_range = list(action.frame_range) if hasattr(action, "frame_range") else []
        report["actions"].append({
            "name": action.name,
            "frame_range": frame_range,
            "fcurve_count": len(action.fcurves) if hasattr(action, "fcurves") else 0
        })

    # Inspect Materials & Textures
    for mat in bpy.data.materials:
        textures = []
        if mat.use_nodes and mat.node_tree:
            for node in mat.node_tree.nodes:
                if node.type == 'TEX_IMAGE' and node.image:
                    textures.append({
                        "node_name": node.name,
                        "image_name": node.image.name,
                        "filepath": node.image.filepath
                    })
        report["materials"].append({
            "name": mat.name,
            "use_nodes": mat.use_nodes,
            "textures": textures
        })

    # Test GLTF export
    gltf_test_path = os.path.join(output_dir, f"{label}_test_export.glb")
    try:
        bpy.ops.export_scene.gltf(
            filepath=gltf_test_path,
            export_format='GLB',
            use_selection=False,
            export_yup=True,
            export_apply=False
        )
        report["gltf_export"] = {
            "success": True,
            "path": gltf_test_path,
            "size_bytes": os.path.getsize(gltf_test_path)
        }
    except Exception as e:
        report["gltf_export"] = {
            "success": False,
            "error": str(e)
        }

    return report

def main():
    base_dir = r"c:\PROJECT\SANKET VAANNI\design-reference"
    ext_dir = os.path.join(base_dir, "extracted")
    out_dir = os.path.join(base_dir, "evaluation_output")
    os.makedirs(out_dir, exist_ok=True)
    
    # 1. FPS Female Arms
    fbx1 = os.path.join(ext_dir, "fps-female-arms", "source", "[FPS Female Arms].fbx")
    tex1 = os.path.join(ext_dir, "fps-female-arms", "textures", "[FPS_Female_Arms]_[FPS_Female_Arms]_Materi.png")
    res1 = analyze_fbx(fbx1, tex1, out_dir, "fps_female_arms")
    
    # 2. VR Hands
    fbx2 = os.path.join(ext_dir, "vr-hands", "source", "Hands VR.fbx")
    tex2 = os.path.join(ext_dir, "vr-hands", "textures", "T_VRHands_Base_color.png")
    res2 = analyze_fbx(fbx2, tex2, out_dir, "vr_hands")
    
    combined = {
        "fps_female_arms": res1,
        "vr_hands": res2
    }
    
    out_json = os.path.join(out_dir, "evaluation_report.json")
    with open(out_json, "w") as f:
        json.dump(combined, f, indent=2)
        
    print(f"\nEvaluation JSON written to: {out_json}")

if __name__ == "__main__":
    main()
