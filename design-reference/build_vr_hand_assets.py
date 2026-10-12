import bpy
import os
import sys
import math
from mathutils import Vector, Euler, Matrix

def reset_blend():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def build_vr_assets():
    log_file = r"c:\PROJECT\SANKET VAANNI\design-reference\evaluation_output\build_vr.log"
    sys.stdout = open(log_file, "w")
    sys.stderr = sys.stdout
    
    base_dir = r"c:\PROJECT\SANKET VAANNI\design-reference"
    ext_dir = os.path.join(base_dir, "extracted")
    out_dir = os.path.join(base_dir, "evaluation_output")
    os.makedirs(out_dir, exist_ok=True)
    
    fbx_vr = os.path.join(ext_dir, "vr-hands", "source", "Hands VR.fbx")
    tex_1k = os.path.join(out_dir, "vr_hands_texture_1k.png")
    
    # Check if 1k texture exists
    if not os.path.exists(tex_1k):
        orig_tex = os.path.join(ext_dir, "vr-hands", "textures", "T_VRHands_Base_color.png")
        img = bpy.data.images.load(orig_tex)
        img.scale(1024, 1024)
        img.filepath_raw = tex_1k
        img.file_format = 'PNG'
        img.save()
        print("Created 1k texture:", tex_1k)
        
    # --- 1. Export BOTH Hands (with smooth shading and 1k texture) ---
    reset_blend()
    bpy.ops.import_scene.fbx(filepath=fbx_vr)
    
    arm_obj = bpy.data.objects.get('Armature')
    mesh_obj = bpy.data.objects.get('SM_HandsVR_Male')
    
    # Material setup
    mat = bpy.data.materials.get('VR_Hands_M')
    if mat and mat.use_nodes:
        bsdf = mat.node_tree.nodes.get('Principled BSDF')
        tex_node = None
        for n in mat.node_tree.nodes:
            if n.type == 'TEX_IMAGE':
                tex_node = n
                break
        if not tex_node:
            tex_node = mat.node_tree.nodes.new('ShaderNodeTexImage')
        tex_node.image = bpy.data.images.load(tex_1k)
        if bsdf:
            mat.node_tree.links.new(tex_node.outputs['Color'], bsdf.inputs['Base Color'])
            bsdf.inputs['Roughness'].default_value = 0.55
            
    # Shade smooth
    bpy.context.view_layer.objects.active = mesh_obj
    bpy.ops.object.shade_smooth()
    
    # Subsurf level 1
    sub = mesh_obj.modifiers.new("Subsurf", 'SUBSURF')
    sub.levels = 1
    sub.render_levels = 1
    
    both_glb = os.path.join(out_dir, "sanket_vaani_vr_both.glb")
    bpy.ops.export_scene.gltf(
        filepath=both_glb,
        export_format='GLB',
        use_selection=False,
        export_yup=True,
        export_apply=False
    )
    print(f"Exported Both Hands GLB: {both_glb} ({os.path.getsize(both_glb)} bytes)")
    
    # --- 2. Create LEFT HAND ONLY ---
    reset_blend()
    bpy.ops.import_scene.gltf(filepath=both_glb)
    
    arm_obj = None
    mesh_obj = None
    for obj in bpy.data.objects:
        if obj.type == 'ARMATURE':
            arm_obj = obj
        elif obj.type == 'MESH':
            mesh_obj = obj
            
    bpy.context.view_layer.objects.active = mesh_obj
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='DESELECT')
    
    import bmesh
    bm = bmesh.from_edit_mesh(mesh_obj.data)
    for v in bm.verts:
        # In GLTF export_yup space, check coordinates of Right Hand
        # Let's see: Right hand had negative X in FBX
        if v.co.x < 0:
            v.select = True
    bmesh.update_edit_mesh(mesh_obj.data)
    bpy.ops.mesh.delete(type='VERT')
    bpy.ops.object.mode_set(mode='OBJECT')
    
    bb = [mesh_obj.matrix_world @ Vector(c) for c in mesh_obj.bound_box]
    center = Vector(((min(c.x for c in bb) + max(c.x for c in bb))/2,
                     (min(c.y for c in bb) + max(c.y for c in bb))/2,
                     (min(c.z for c in bb) + max(c.z for c in bb))/2))
    print(f"Left Hand center: {center}")
    
    # Center left hand at origin
    arm_obj.location -= center
    mesh_obj.location -= center
    bpy.context.view_layer.update()
    
    left_glb = os.path.join(out_dir, "sanket_vaani_vr_left.glb")
    bpy.ops.export_scene.gltf(
        filepath=left_glb,
        export_format='GLB',
        use_selection=False,
        export_yup=True,
        export_apply=False
    )
    print(f"Exported Left Hand GLB: {left_glb} ({os.path.getsize(left_glb)} bytes)")
    
    # --- 3. Create RIGHT HAND ONLY ---
    reset_blend()
    bpy.ops.import_scene.gltf(filepath=both_glb)
    
    arm_obj = None
    mesh_obj = None
    for obj in bpy.data.objects:
        if obj.type == 'ARMATURE':
            arm_obj = obj
        elif obj.type == 'MESH':
            mesh_obj = obj
            
    bpy.context.view_layer.objects.active = mesh_obj
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='DESELECT')
    
    bm = bmesh.from_edit_mesh(mesh_obj.data)
    for v in bm.verts:
        if v.co.x > 0:
            v.select = True
    bmesh.update_edit_mesh(mesh_obj.data)
    bpy.ops.mesh.delete(type='VERT')
    bpy.ops.object.mode_set(mode='OBJECT')
    
    bb = [mesh_obj.matrix_world @ Vector(c) for c in mesh_obj.bound_box]
    center = Vector(((min(c.x for c in bb) + max(c.x for c in bb))/2,
                     (min(c.y for c in bb) + max(c.y for c in bb))/2,
                     (min(c.z for c in bb) + max(c.z for c in bb))/2))
    print(f"Right Hand center: {center}")
    
    arm_obj.location -= center
    mesh_obj.location -= center
    bpy.context.view_layer.update()
    
    right_glb = os.path.join(out_dir, "sanket_vaani_vr_right.glb")
    bpy.ops.export_scene.gltf(
        filepath=right_glb,
        export_format='GLB',
        use_selection=False,
        export_yup=True,
        export_apply=False
    )
    print(f"Exported Right Hand GLB: {right_glb} ({os.path.getsize(right_glb)} bytes)")
    print("All exports completed successfully!")

if __name__ == "__main__":
    build_vr_assets()
