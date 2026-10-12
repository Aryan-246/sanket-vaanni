import bpy
import os
import math
from mathutils import Vector, Euler

def reset_blend():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def create_blender_assets():
    base_dir = r"c:\PROJECT\SANKET VAANNI\design-reference"
    ext_dir = os.path.join(base_dir, "extracted")
    out_dir = os.path.join(base_dir, "evaluation_output")
    os.makedirs(out_dir, exist_ok=True)
    
    fbx_fps = os.path.join(ext_dir, "fps-female-arms", "source", "[FPS Female Arms].fbx")
    tex_fps = os.path.join(ext_dir, "fps-female-arms", "textures", "[FPS_Female_Arms]_[FPS_Female_Arms]_Materi.png")
    
    reset_blend()
    bpy.ops.import_scene.fbx(filepath=fbx_fps)
    
    arm_obj = bpy.data.objects.get('[FPS Female Arms] RIG')
    left_mesh = bpy.data.objects.get('[FPS Female Left Arm]')
    right_mesh = bpy.data.objects.get('[FPS Female Right Arm]')
    
    # Setup material with the texture image properly linked
    mat = bpy.data.materials.get('[FPS Female Arms] Material')
    if mat and mat.use_nodes:
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        bsdf = nodes.get('Principled BSDF')
        
        # Check if texture node exists
        tex_node = None
        for n in nodes:
            if n.type == 'TEX_IMAGE':
                tex_node = n
                break
        if not tex_node:
            tex_node = nodes.new('ShaderNodeTexImage')
            tex_node.location = (-300, 300)
            
        if os.path.exists(tex_fps):
            img = bpy.data.images.load(tex_fps)
            tex_node.image = img
            
        if bsdf and tex_node:
            links.new(tex_node.outputs['Color'], bsdf.inputs['Base Color'])
            bsdf.inputs['Roughness'].default_value = 0.55
            
    # Save the master .blend file
    blend_path = os.path.join(out_dir, "sanket_vaani_hands.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)
    print("Saved master .blend to:", blend_path)
    
    # 1. Export Full Left Arm GLB
    # Deselect all, select Left Arm and Armature
    bpy.ops.object.select_all(action='DESELECT')
    arm_obj.select_set(True)
    left_mesh.select_set(True)
    right_mesh.select_set(False)
    bpy.context.view_layer.objects.active = arm_obj
    
    left_glb_path = os.path.join(out_dir, "sanket_vaani_left_arm.glb")
    bpy.ops.export_scene.gltf(
        filepath=left_glb_path,
        export_format='GLB',
        use_selection=True,
        export_yup=True,
        export_apply=False
    )
    print("Exported Left Arm GLB to:", left_glb_path)
    
    # 2. Export Full Right Arm GLB
    bpy.ops.object.select_all(action='DESELECT')
    arm_obj.select_set(True)
    right_mesh.select_set(True)
    left_mesh.select_set(False)
    bpy.context.view_layer.objects.active = arm_obj
    
    right_glb_path = os.path.join(out_dir, "sanket_vaani_right_arm.glb")
    bpy.ops.export_scene.gltf(
        filepath=right_glb_path,
        export_format='GLB',
        use_selection=True,
        export_yup=True,
        export_apply=False
    )
    print("Exported Right Arm GLB to:", right_glb_path)
    
    # 3. Export VR Hands Left and Right for comparison
    fbx_vr = os.path.join(ext_dir, "vr-hands", "source", "Hands VR.fbx")
    tex_vr = os.path.join(ext_dir, "vr-hands", "textures", "T_VRHands_Base_color.png")
    reset_blend()
    bpy.ops.import_scene.fbx(filepath=fbx_vr)
    
    vr_mat = bpy.data.materials.get('VR_Hands_M')
    if vr_mat and vr_mat.use_nodes:
        nodes = vr_mat.node_tree.nodes
        links = vr_mat.node_tree.links
        bsdf = nodes.get('Principled BSDF')
        tex_node = None
        for n in nodes:
            if n.type == 'TEX_IMAGE':
                tex_node = n
                break
        if not tex_node:
            tex_node = nodes.new('ShaderNodeTexImage')
        if os.path.exists(tex_vr):
            img = bpy.data.images.load(tex_vr)
            tex_node.image = img
        if bsdf and tex_node:
            links.new(tex_node.outputs['Color'], bsdf.inputs['Base Color'])
            
    vr_glb_path = os.path.join(out_dir, "sanket_vaani_vr_hands_both.glb")
    bpy.ops.export_scene.gltf(
        filepath=vr_glb_path,
        export_format='GLB',
        use_selection=False,
        export_yup=True,
        export_apply=False
    )
    print("Exported VR Hands GLB to:", vr_glb_path)

if __name__ == "__main__":
    create_blender_assets()
