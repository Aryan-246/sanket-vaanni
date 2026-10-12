import bpy
import os
import math
from mathutils import Vector, Euler

def render_ground_truth():
    base_dir = r"c:\PROJECT\SANKET VAANNI\design-reference"
    out_dir = os.path.join(base_dir, "evaluation_output")
    os.makedirs(out_dir, exist_ok=True)
    
    poses = {
        "rest": {
            "thumb": (0, 0),
            "index": 0,
            "middle": 0,
            "ring": 0,
            "pinky": 0,
        },
        "fist": {
            "thumb": (50, 35),
            "index": 80,
            "middle": 85,
            "ring": 85,
            "pinky": 80,
        },
        "point": {
            "thumb": (50, 35),
            "index": 0,
            "middle": 85,
            "ring": 85,
            "pinky": 80,
        },
        "peace": {
            "thumb": (50, 35),
            "index": 0,
            "middle": 0,
            "ring": 85,
            "pinky": 80,
        },
        "thumbs_up": {
            "thumb": (0, 0),
            "index": 85,
            "middle": 85,
            "ring": 85,
            "pinky": 80,
        },
        "relaxed": {
            "thumb": (15, 10),
            "index": 20,
            "middle": 25,
            "ring": 28,
            "pinky": 30,
        }
    }
    
    for side in ["left", "right"]:
        is_left = (side == "left")
        glb_path = os.path.join(out_dir, f"sanket_vaani_vr_{side}.glb")
        
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=glb_path)
        
        arm_obj = None
        mesh_obj = None
        for obj in bpy.data.objects:
            if obj.type == 'ARMATURE': arm_obj = obj
            elif obj.type == 'MESH': mesh_obj = obj
            
        scene = bpy.context.scene
        scene.render.resolution_x = 480
        scene.render.resolution_y = 480
        scene.render.image_settings.file_format = 'PNG'
        
        # Camera
        cam_data = bpy.data.cameras.new("Cam")
        cam_obj = bpy.data.objects.new("Cam", cam_data)
        bpy.context.collection.objects.link(cam_obj)
        scene.camera = cam_obj
        
        x_target = 0.02 if is_left else -0.02
        cam_obj.location = Vector((x_target, 0.0, -0.42))
        cam_obj.rotation_euler = Euler((0, math.pi, math.pi), 'XYZ')
        
        # Lights
        l1 = bpy.data.lights.new("Key", 'SUN')
        l1.energy = 3.5
        l1_obj = bpy.data.objects.new("Key", l1)
        bpy.context.collection.objects.link(l1_obj)
        l1_obj.rotation_euler = Euler((math.radians(45), math.radians(-30), math.radians(20)), 'XYZ')
        
        l2 = bpy.data.lights.new("Fill", 'SUN')
        l2.energy = 2.0
        l2.color = (0.5, 0.7, 0.9)
        l2_obj = bpy.data.objects.new("Fill", l2)
        bpy.context.collection.objects.link(l2_obj)
        l2_obj.rotation_euler = Euler((math.radians(-30), math.radians(45), 0), 'XYZ')
        
        l3 = bpy.data.lights.new("Rim", 'SUN')
        l3.energy = 2.5
        l3.color = (0.9, 0.9, 1.0)
        l3_obj = bpy.data.objects.new("Rim", l3)
        bpy.context.collection.objects.link(l3_obj)
        l3_obj.rotation_euler = Euler((math.radians(120), 0, math.radians(45)), 'XYZ')
        
        prefix = "J_Left_Hand" if is_left else "J_Right_Hand"
        
        bpy.context.view_layer.objects.active = arm_obj
        bpy.ops.object.mode_set(mode='POSE')
        
        for pose_name, pose_data in poses.items():
            # Reset all bones
            for pb in arm_obj.pose.bones:
                pb.rotation_mode = 'XYZ'
                pb.rotation_euler = Euler((0, 0, 0), 'XYZ')
                
            # Apply thumb
            t_bend, t_opp = pose_data["thumb"]
            tb1 = arm_obj.pose.bones.get(f"{prefix}Thumb1")
            tb2 = arm_obj.pose.bones.get(f"{prefix}Thumb2")
            tb3 = arm_obj.pose.bones.get(f"{prefix}Thumb3")
            if tb1:
                opp_sign = 1 if is_left else -1
                tb1.rotation_euler = Euler((math.radians(t_bend * 0.9), math.radians(opp_sign * t_opp), 0), 'XYZ')
            if tb2:
                tb2.rotation_euler = Euler((math.radians(t_bend * 1.1), 0, 0), 'XYZ')
            if tb3:
                tb3.rotation_euler = Euler((math.radians(t_bend), 0, 0), 'XYZ')
                
            # Apply 4 fingers
            for fname in ["Index", "Middle", "Ring", "Pinky"]:
                f_bend = pose_data[fname.lower()]
                for j in [1, 2, 3]:
                    bone = arm_obj.pose.bones.get(f"{prefix}{fname}{j}")
                    if bone:
                        bone.rotation_euler = Euler((math.radians(f_bend), 0, 0), 'XYZ')
                        
            bpy.context.view_layer.update()
            out_img = os.path.join(out_dir, f"verified_{side}_{pose_name}.png")
            scene.render.filepath = out_img
            bpy.ops.render.render(write_still=True)
            print(f"Rendered {side} {pose_name} -> {out_img}")

if __name__ == "__main__":
    render_ground_truth()
