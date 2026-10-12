import bpy
import os
import math
from mathutils import Vector, Euler

bpy.ops.wm.read_factory_settings(use_empty=True)

out_dir = r"c:\PROJECT\SANKET VAANNI\design-reference\evaluation_output"
glb_path = os.path.join(out_dir, "sanket_vaani_vr_left.glb")

bpy.ops.import_scene.gltf(filepath=glb_path)

arm_obj = None
for obj in bpy.data.objects:
    if obj.type == 'ARMATURE':
        arm_obj = obj
        break

bpy.context.view_layer.objects.active = arm_obj
bpy.ops.object.mode_set(mode='POSE')

# Let's test rotating Y vs X vs Z on J_Left_HandIndex1..3
# In Blender, let's see which axis curls Index:
for axis_name, axis_idx in [('Y', 1), ('X', 0), ('Z', 2)]:
    # Reset all
    for pb in arm_obj.pose.bones:
        pb.rotation_euler = Euler((0,0,0), 'XYZ')
        
    for j in range(1, 4):
        pb = arm_obj.pose.bones.get(f'J_Left_HandIndex{j}')
        if pb:
            euler = [0, 0, 0]
            euler[axis_idx] = math.radians(70)
            pb.rotation_mode = 'XYZ'
            pb.rotation_euler = Euler(euler, 'XYZ')
            
    bpy.context.view_layer.update()
    
    # Render with palm view
    scene = bpy.context.scene
    scene.render.resolution_x = 400
    scene.render.resolution_y = 400
    scene.render.image_settings.file_format = 'PNG'
    
    # Remove existing cameras/lights
    for obj in list(bpy.data.objects):
        if obj.type in ('CAMERA', 'LIGHT'):
            bpy.data.objects.remove(obj)
            
    cam_data = bpy.data.cameras.new("Cam")
    cam_obj = bpy.data.objects.new("Cam", cam_data)
    bpy.context.collection.objects.link(cam_obj)
    scene.camera = cam_obj
    cam_obj.location = Vector((0.02, 0.0, -0.42))
    cam_obj.rotation_euler = Euler((0, math.pi, math.pi), 'XYZ')
    
    l1 = bpy.data.lights.new("Sun", 'SUN')
    l1.energy = 4.0
    l1_obj = bpy.data.objects.new("Sun", l1)
    bpy.context.collection.objects.link(l1_obj)
    l1_obj.rotation_euler = Euler((math.radians(30), math.radians(-20), 0), 'XYZ')
    
    out_img = os.path.join(out_dir, f"test_curl_index_{axis_name}.png")
    scene.render.filepath = out_img
    bpy.ops.render.render(write_still=True)
    print(f"Rendered index curl {axis_name} to {out_img}")

print("Index curl tests complete!")
