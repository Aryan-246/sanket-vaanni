import bpy
import os
import math
from mathutils import Vector, Euler

bpy.ops.wm.read_factory_settings(use_empty=True)

base_dir = r"c:\PROJECT\SANKET VAANNI\design-reference"
ext_dir = os.path.join(base_dir, "extracted")
out_dir = os.path.join(base_dir, "evaluation_output")
os.makedirs(out_dir, exist_ok=True)

fbx_vr = os.path.join(ext_dir, "vr-hands", "source", "Hands VR.fbx")
tex_vr = os.path.join(ext_dir, "vr-hands", "textures", "T_VRHands_Base_color.png")

# 1. Resize texture to 1K for mobile optimization
img_orig = bpy.data.images.load(tex_vr)
print(f"Original VR texture size: {img_orig.size[0]}x{img_orig.size[1]}")
img_1k = img_orig.copy()
img_1k.scale(1024, 1024)
tex_1k_path = os.path.join(out_dir, "vr_hands_texture_1k.png")
img_1k.filepath_raw = tex_1k_path
img_1k.file_format = 'PNG'
img_1k.save()
print(f"Saved 1K texture to: {tex_1k_path} ({os.path.getsize(tex_1k_path)} bytes)")

# 2. Import FBX
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx_vr)

arm_obj = bpy.data.objects.get('Armature')
mesh_obj = bpy.data.objects.get('SM_HandsVR_Male')

# Setup material
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
    tex_node.image = bpy.data.images.load(tex_1k_path)
    if bsdf:
        mat.node_tree.links.new(tex_node.outputs['Color'], bsdf.inputs['Base Color'])
        bsdf.inputs['Roughness'].default_value = 0.6

# Smooth shading
bpy.context.view_layer.objects.active = mesh_obj
bpy.ops.object.shade_smooth()

# Test Subdivision modifier
subsurf = mesh_obj.modifiers.new(name="Subdivision", type='SUBSURF')
subsurf.levels = 1
subsurf.render_levels = 1

# Setup camera and lighting for pose test renders
bpy.ops.object.camera_add(location=(25, -50, 20), rotation=(math.radians(70), 0, math.radians(20)))
cam = bpy.context.active_object
bpy.context.scene.camera = cam

# Light
bpy.ops.object.light_add(type='SUN', location=(20, -30, 40))
sun = bpy.context.active_object
sun.data.energy = 3.0

bpy.context.scene.render.resolution_x = 640
bpy.context.scene.render.resolution_y = 640

# Test bone axes in pose mode
bpy.context.view_layer.objects.active = arm_obj
bpy.ops.object.mode_set(mode='POSE')

# Helper to test curling
# Let's inspect which axis curls J_Left_HandIndex1
for axis in ['X', 'Y', 'Z']:
    pbone = arm_obj.pose.bones.get('J_Left_HandIndex1')
    pbone.rotation_mode = 'XYZ'
    euler_val = [0, 0, 0]
    idx = {'X':0, 'Y':1, 'Z':2}[axis]
    euler_val[idx] = math.radians(50)
    pbone.rotation_euler = Euler(euler_val, 'XYZ')
    bpy.context.view_layer.update()
    
    # Render test frame
    out_img = os.path.join(out_dir, f"test_curl_axis_{axis}.png")
    bpy.context.scene.render.filepath = out_img
    bpy.ops.render.render(write_still=True)
    print(f"Rendered axis test {axis} to {out_img}")
    
    pbone.rotation_euler = Euler((0, 0, 0), 'XYZ')
    bpy.context.view_layer.update()

print("Pose axis test complete!")
