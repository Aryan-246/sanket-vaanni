import bpy
import os
import math
from mathutils import Vector, Euler

def optimize_and_export():
    base_dir = r"c:\PROJECT\SANKET VAANNI\design-reference"
    ext_dir = os.path.join(base_dir, "extracted")
    out_dir = os.path.join(base_dir, "evaluation_output")
    
    fbx_fps = os.path.join(ext_dir, "fps-female-arms", "source", "[FPS Female Arms].fbx")
    orig_tex_path = os.path.join(ext_dir, "fps-female-arms", "textures", "[FPS_Female_Arms]_[FPS_Female_Arms]_Materi.png")
    
    # 1. Load original 4K texture and create 1K and 2K optimized textures
    bpy.ops.wm.read_factory_settings(use_empty=True)
    img_orig = bpy.data.images.load(orig_tex_path)
    print(f"Original texture: {img_orig.size[0]}x{img_orig.size[1]}, file size: {os.path.getsize(orig_tex_path)} bytes")
    
    # Create 2048x2048 version
    img_2k = img_orig.copy()
    img_2k.scale(2048, 2048)
    path_2k = os.path.join(out_dir, "hand_texture_2k.png")
    img_2k.filepath_raw = path_2k
    img_2k.file_format = 'PNG'
    img_2k.save()
    
    # Create 1024x1024 version
    img_1k = img_orig.copy()
    img_1k.scale(1024, 1024)
    path_1k = os.path.join(out_dir, "hand_texture_1k.png")
    img_1k.filepath_raw = path_1k
    img_1k.file_format = 'PNG'
    img_1k.save()
    
    print(f"2K texture saved: {path_2k} ({os.path.getsize(path_2k)} bytes)")
    print(f"1K texture saved: {path_1k} ({os.path.getsize(path_1k)} bytes)")
    
    # 2. Export 1K and 2K GLB models for Left and Right hands
    for res_name, tex_path in [("2k", path_2k), ("1k", path_1k)]:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.fbx(filepath=fbx_fps)
        
        arm_obj = bpy.data.objects.get('[FPS Female Arms] RIG')
        left_mesh = bpy.data.objects.get('[FPS Female Left Arm]')
        right_mesh = bpy.data.objects.get('[FPS Female Right Arm]')
        
        mat = bpy.data.materials.get('[FPS Female Arms] Material')
        if mat and mat.use_nodes:
            bsdf = mat.node_tree.nodes.get('Principled BSDF')
            tex_node = mat.node_tree.nodes.new('ShaderNodeTexImage')
            tex_node.image = bpy.data.images.load(tex_path)
            if bsdf:
                mat.node_tree.links.new(tex_node.outputs['Color'], bsdf.inputs['Base Color'])
                bsdf.inputs['Roughness'].default_value = 0.55
                
        # Export Left
        bpy.ops.object.select_all(action='DESELECT')
        arm_obj.select_set(True)
        left_mesh.select_set(True)
        right_mesh.select_set(False)
        bpy.context.view_layer.objects.active = arm_obj
        
        out_left = os.path.join(out_dir, f"sanket_vaani_left_{res_name}.glb")
        bpy.ops.export_scene.gltf(
            filepath=out_left,
            export_format='GLB',
            use_selection=True,
            export_yup=True,
            export_apply=False
        )
        print(f"Exported Left {res_name}: {out_left} ({os.path.getsize(out_left)} bytes)")
        
        # Export Right
        bpy.ops.object.select_all(action='DESELECT')
        arm_obj.select_set(True)
        right_mesh.select_set(True)
        left_mesh.select_set(False)
        bpy.context.view_layer.objects.active = arm_obj
        
        out_right = os.path.join(out_dir, f"sanket_vaani_right_{res_name}.glb")
        bpy.ops.export_scene.gltf(
            filepath=out_right,
            export_format='GLB',
            use_selection=True,
            export_yup=True,
            export_apply=False
        )
        print(f"Exported Right {res_name}: {out_right} ({os.path.getsize(out_right)} bytes)")

if __name__ == "__main__":
    optimize_and_export()
