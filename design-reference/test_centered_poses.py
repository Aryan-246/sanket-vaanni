import bpy
import os
import math
from mathutils import Vector, Euler

def test_centered():
    base_dir = r"c:\PROJECT\SANKET VAANNI\design-reference"
    out_dir = os.path.join(base_dir, "evaluation_output")
    
    glb_left = os.path.join(out_dir, "sanket_vaani_vr_left.glb")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=glb_left)
    
    arm_obj = None
    mesh_obj = None
    for obj in bpy.data.objects:
        if obj.type == 'ARMATURE': arm_obj = obj
        elif obj.type == 'MESH': mesh_obj = obj
        
    # Calculate exact center of mesh
    bb = [mesh_obj.matrix_world @ Vector(c) for c in mesh_obj.bound_box]
    center = Vector(((min(c.x for c in bb) + max(c.x for c in bb))/2,
                     (min(c.y for c in bb) + max(c.y for c in bb))/2,
                     (min(c.z for c in bb) + max(c.z for c in bb))/2))
    print("Exact world center of left hand:", center)
    
    # Center both armature and mesh at (0, 0, 0)
    arm_obj.location -= center
    mesh_obj.location -= center
    bpy.context.view_layer.update()
    
    scene = bpy.context.scene
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.image_settings.file_format = 'PNG'
    
    for obj in list(bpy.data.objects):
        if obj.type in ('CAMERA', 'LIGHT'):
            bpy.data.objects.remove(obj)
            
    # Camera looking at origin (0, 0, 0) from distance 0.35
    cam_data = bpy.data.cameras.new("Cam")
    cam_obj = bpy.data.objects.new("Cam", cam_data)
    bpy.context.collection.objects.link(cam_obj)
    scene.camera = cam_obj
    cam_obj.location = Vector((0.0, 0.0, -0.36))
    cam_obj.rotation_euler = Euler((0, math.pi, math.pi), 'XYZ')
    
    # Front key light
    l1 = bpy.data.lights.new("Key", 'SUN')
    l1.energy = 4.0
    l1_obj = bpy.data.objects.new("Key", l1)
    bpy.context.collection.objects.link(l1_obj)
    l1_obj.rotation_euler = Euler((math.radians(15), math.radians(-15), 0), 'XYZ')
    
    # Soft fill light
    fill = bpy.data.lights.new("Fill", 'SUN')
    fill.energy = 2.5
    fill.color = (0.7, 0.9, 1.0)
    fill_obj = bpy.data.objects.new("Fill", fill)
    bpy.context.collection.objects.link(fill_obj)
    fill_obj.rotation_euler = Euler((math.radians(-15), math.radians(20), 0), 'XYZ')
    
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode='POSE')
    
    # Test 1: Rest pose
    for pb in arm_obj.pose.bones:
        pb.rotation_mode = 'XYZ'
        pb.rotation_euler = Euler((0,0,0), 'XYZ')
    bpy.context.view_layer.update()
    out1 = os.path.join(out_dir, "test_centered_rest.png")
    scene.render.filepath = out1
    bpy.ops.render.render(write_still=True)
    
    # Test 2: Fist pose
    # Curl thumb
    for j in [1, 2, 3]:
        pb = arm_obj.pose.bones.get(f'J_Left_HandThumb{j}')
        if pb: pb.rotation_euler = Euler((math.radians(50), math.radians(35 if j==1 else 0), 0), 'XYZ')
    # Curl 4 fingers
    for fname in ['Index', 'Middle', 'Ring', 'Pinky']:
        for j in [1, 2, 3]:
            pb = arm_obj.pose.bones.get(f'J_Left_Hand{fname}{j}')
            if pb: pb.rotation_euler = Euler((math.radians(75), 0, 0), 'XYZ')
    bpy.context.view_layer.update()
    out2 = os.path.join(out_dir, "test_centered_fist.png")
    scene.render.filepath = out2
    bpy.ops.render.render(write_still=True)
    
    # Test 3: Point pose (Index straight, others curled)
    for pb in arm_obj.pose.bones:
        if 'Index' in pb.name:
            pb.rotation_euler = Euler((0, 0, 0), 'XYZ')
    bpy.context.view_layer.update()
    out3 = os.path.join(out_dir, "test_centered_point.png")
    scene.render.filepath = out3
    bpy.ops.render.render(write_still=True)

if __name__ == "__main__":
    test_centered()
