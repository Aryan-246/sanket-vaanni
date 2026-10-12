import bpy
import os
import math
from mathutils import Vector, Euler

def test_poses():
    base_dir = r"c:\PROJECT\SANKET VAANNI\design-reference"
    out_dir = os.path.join(base_dir, "evaluation_output")
    
    poses = {
        "rest": {
            "fingers": [0.0, 0.0, 0.0, 0.0, 0.0],
            "wrist": {"pitch": 0, "roll": 0}
        },
        "relaxed": {
            "fingers": [0.2, 0.25, 0.25, 0.25, 0.25],
            "wrist": {"pitch": 0, "roll": 0}
        },
        "fist": {
            "fingers": [0.95, 1.0, 1.0, 1.0, 1.0],
            "wrist": {"pitch": 0, "roll": 0}
        },
        "point": {
            "fingers": [0.9, 0.0, 1.0, 1.0, 1.0],
            "wrist": {"pitch": 0, "roll": 0}
        },
        "peace": {
            "fingers": [0.9, 0.0, 0.0, 1.0, 1.0],
            "wrist": {"pitch": 0, "roll": 0}
        },
        "thumbs_up": {
            "fingers": [0.0, 1.0, 1.0, 1.0, 1.0],
            "wrist": {"pitch": -15, "roll": 0}
        }
    }
    
    # Test on Left hand
    glb_left = os.path.join(out_dir, "sanket_vaani_vr_left.glb")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=glb_left)
    
    arm_obj = None
    for obj in bpy.data.objects:
        if obj.type == 'ARMATURE':
            arm_obj = obj
            break
            
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode='POSE')
    
    scene = bpy.context.scene
    scene.render.resolution_x = 400
    scene.render.resolution_y = 400
    scene.render.image_settings.file_format = 'PNG'
    
    for obj in list(bpy.data.objects):
        if obj.type in ('CAMERA', 'LIGHT'):
            bpy.data.objects.remove(obj)
            
    cam_data = bpy.data.cameras.new("Cam")
    cam_obj = bpy.data.objects.new("Cam", cam_data)
    bpy.context.collection.objects.link(cam_obj)
    scene.camera = cam_obj
    cam_obj.location = Vector((0.02, 0.0, -0.42))
    cam_obj.rotation_euler = Euler((0, math.pi, math.pi), 'XYZ')
    
    l1 = bpy.data.lights.new("Key", 'SUN')
    l1.energy = 4.0
    l1_obj = bpy.data.objects.new("Key", l1)
    bpy.context.collection.objects.link(l1_obj)
    l1_obj.rotation_euler = Euler((math.radians(20), math.radians(-20), 0), 'XYZ')
    
    fill = bpy.data.lights.new("Fill", 'SUN')
    fill.energy = 2.0
    fill.color = (0.5, 0.8, 1.0)
    fill_obj = bpy.data.objects.new("Fill", fill)
    bpy.context.collection.objects.link(fill_obj)
    fill_obj.rotation_euler = Euler((math.radians(-20), math.radians(30), 0), 'XYZ')
    
    def apply_hand_pose(arm, pose_data, is_left=True):
        prefix = 'J_Left_Hand' if is_left else 'J_Right_Hand'
        sign = 1.0 if is_left else -1.0 # check mirroring
        
        # Reset
        for pb in arm.pose.bones:
            pb.rotation_mode = 'XYZ'
            pb.rotation_euler = Euler((0, 0, 0), 'XYZ')
            
        # Wrist
        w_pitch = pose_data['wrist'].get('pitch', 0)
        w_roll = pose_data['wrist'].get('roll', 0)
        wrist_b = arm.pose.bones.get(prefix)
        if wrist_b:
            wrist_b.rotation_euler = Euler((math.radians(w_pitch), 0, math.radians(w_roll)), 'XYZ')
            
        # Thumb: fingers[0]
        t_val = pose_data['fingers'][0]
        tb1 = arm.pose.bones.get(f'{prefix}Thumb1')
        tb2 = arm.pose.bones.get(f'{prefix}Thumb2')
        tb3 = arm.pose.bones.get(f'{prefix}Thumb3')
        if tb1:
            # Opposition + flex
            tb1.rotation_euler = Euler((math.radians(t_val * 45), math.radians(t_val * 30), 0), 'XYZ')
        if tb2:
            tb2.rotation_euler = Euler((math.radians(t_val * 55), 0, 0), 'XYZ')
        if tb3:
            tb3.rotation_euler = Euler((math.radians(t_val * 50), 0, 0), 'XYZ')
            
        # 4 fingers: Index (1), Middle (2), Ring (3), Pinky (4)
        finger_names = ['Index', 'Middle', 'Ring', 'Pinky']
        for i, fname in enumerate(finger_names):
            bend = pose_data['fingers'][i + 1]
            for j in [1, 2, 3]:
                pb = arm.pose.bones.get(f'{prefix}{fname}{j}')
                if pb:
                    deg = 75 if j == 1 else (80 if j == 2 else 60)
                    pb.rotation_euler = Euler((math.radians(bend * deg), 0, 0), 'XYZ')
                    
        bpy.context.view_layer.update()
        
    for pname, pdata in poses.items():
        apply_hand_pose(arm_obj, pdata, is_left=True)
        out_render = os.path.join(out_dir, f"vr_pose_left_{pname}.png")
        scene.render.filepath = out_render
        bpy.ops.render.render(write_still=True)
        print(f"Rendered left {pname} to {out_render}")

if __name__ == "__main__":
    test_poses()
