import bpy
import os
import math
from mathutils import Vector, Euler

bpy.ops.wm.read_factory_settings(use_empty=True)

out_dir = r"c:\PROJECT\SANKET VAANNI\design-reference\evaluation_output"
glb_path = os.path.join(out_dir, "sanket_vaani_vr_left.glb")

bpy.ops.import_scene.gltf(filepath=glb_path)

scene = bpy.context.scene
scene.render.resolution_x = 512
scene.render.resolution_y = 512
scene.render.image_settings.file_format = 'PNG'

# Remove existing cameras/lights
for obj in list(bpy.data.objects):
    if obj.type in ('CAMERA', 'LIGHT'):
        bpy.data.objects.remove(obj)

# Add Camera looking at (0, 0, 0) from (0, -0.4, 0)
cam_data = bpy.data.cameras.new("Cam")
cam_obj = bpy.data.objects.new("Cam", cam_data)
bpy.context.collection.objects.link(cam_obj)
scene.camera = cam_obj
cam_obj.location = Vector((0, -0.45, 0))
direction = Vector((0, 0, 0)) - cam_obj.location
cam_obj.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()

# Lights
light_data = bpy.data.lights.new("Sun", 'SUN')
light_data.energy = 4.0
light_obj = bpy.data.objects.new("Sun", light_data)
bpy.context.collection.objects.link(light_obj)
light_obj.location = Vector((1, -2, 2))

# Render Front view (-Y)
out_front = os.path.join(out_dir, "test_render_front_negY.png")
scene.render.filepath = out_front
bpy.ops.render.render(write_still=True)

# Try from +Z (top/front in Blender)
cam_obj.location = Vector((0, 0, 0.45))
direction = Vector((0, 0, 0)) - cam_obj.location
cam_obj.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
out_z = os.path.join(out_dir, "test_render_from_posZ.png")
scene.render.filepath = out_z
bpy.ops.render.render(write_still=True)

print("Rendered front and Z views successfully!")
