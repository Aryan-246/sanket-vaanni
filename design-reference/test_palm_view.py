import bpy
import os
import math
from mathutils import Vector, Euler

bpy.ops.wm.read_factory_settings(use_empty=True)

out_dir = r"c:\PROJECT\SANKET VAANNI\design-reference\evaluation_output"
glb_path = os.path.join(out_dir, "sanket_vaani_vr_left.glb")

bpy.ops.import_scene.gltf(filepath=glb_path)

scene = bpy.context.scene
scene.render.resolution_x = 600
scene.render.resolution_y = 600
scene.render.image_settings.file_format = 'PNG'

# Remove existing cameras/lights
for obj in list(bpy.data.objects):
    if obj.type in ('CAMERA', 'LIGHT'):
        bpy.data.objects.remove(obj)

# Palm view: camera looking from -Z towards (0, 0, 0), with Y up
cam_data = bpy.data.cameras.new("Cam")
cam_obj = bpy.data.objects.new("Cam", cam_data)
bpy.context.collection.objects.link(cam_obj)
scene.camera = cam_obj

# In test_render_from_posZ:
# fingers pointed towards -Y, wrist was at +Y, and back was at +Z
# So fingers pointing UP means we want fingers (+Y) or we rotate model 180 around Z!
# If we look from -Z (palm side):
cam_obj.location = Vector((0.02, 0.0, -0.42))
# Camera looking towards (0.02, 0.0, 0) with fingers pointing UP (+Y)
# But in test_render_from_posZ, wrist was at top (greater Y) and fingers at bottom (lesser Y).
# So to make wrist at bottom and fingers at top, camera up vector should be -Y!
cam_obj.rotation_euler = Euler((0, math.pi, math.pi), 'XYZ')

# Three-point lighting
# Key light (soft warm white)
l1 = bpy.data.lights.new("Key", 'SUN')
l1.energy = 3.5
l1_obj = bpy.data.objects.new("Key", l1)
bpy.context.collection.objects.link(l1_obj)
l1_obj.rotation_euler = Euler((math.radians(45), math.radians(-30), math.radians(20)), 'XYZ')

# Fill light (cyan/blue ambient fill)
l2 = bpy.data.lights.new("Fill", 'SUN')
l2.energy = 2.0
l2.color = (0.3, 0.7, 0.9)
l2_obj = bpy.data.objects.new("Fill", l2)
bpy.context.collection.objects.link(l2_obj)
l2_obj.rotation_euler = Euler((math.radians(-30), math.radians(45), 0), 'XYZ')

# Rim light (highlight silhouette)
l3 = bpy.data.lights.new("Rim", 'SUN')
l3.energy = 2.5
l3.color = (0.8, 0.9, 1.0)
l3_obj = bpy.data.objects.new("Rim", l3)
bpy.context.collection.objects.link(l3_obj)
l3_obj.rotation_euler = Euler((math.radians(120), 0, math.radians(45)), 'XYZ')

out_palm = os.path.join(out_dir, "test_render_palm_view.png")
scene.render.filepath = out_palm
bpy.ops.render.render(write_still=True)
print("Rendered palm view to:", out_palm)
