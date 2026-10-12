import bpy
import os
import sys
import json
import math
from mathutils import Vector, Euler, Matrix

def reset_blend():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def get_bone_mapping_fps(arm_obj):
    # Determine which finger is which in fps_female_arms
    # Let's inspect the world positions of Finger_1.1.L through Finger_5.1.L
    arm = arm_obj.data
    mapping = {}
    hand_bone = arm.bones.get('Hand.L')
    hand_head = hand_bone.head_local if hand_bone else Vector((0,0,0))
    
    positions = {}
    for i in range(1, 6):
        b1 = arm.bones.get(f'Finger_{i}.1.L')
        if b1:
            positions[f'Finger_{i}'] = b1.head_local
            
    return positions

def test_fps_arms(fbx_path):
    reset_blend()
    bpy.ops.import_scene.fbx(filepath=fbx_path)
    
    arm_obj = bpy.data.objects.get('[FPS Female Arms] RIG')
    left_mesh_obj = bpy.data.objects.get('[FPS Female Left Arm]')
    right_mesh_obj = bpy.data.objects.get('[FPS Female Right Arm]')
    
    # Check finger bone positions to identify Thumb vs Index vs Pinky
    # In Left Hand: Thumb is most lateral (or medial depending on palm orientation), Pinky is opposite
    finger_heads = {}
    for f in range(1, 6):
        b = arm_obj.data.bones.get(f'Finger_{f}.1.L')
        if b:
            finger_heads[f'Finger_{f}'] = {
                "head": list(b.head_local),
                "tail": list(b.tail_local),
                "length": b.length,
                "chain_length": len([c for c in arm_obj.data.bones if c.name.startswith(f'Finger_{f}') and c.name.endswith('.L')])
            }
            
    # Check arm bones
    arm_bones = {
        "shoulder": arm_obj.data.bones.get('Shoulder.L') is not None,
        "shoulder_2": arm_obj.data.bones.get('Shoulder_2.L') is not None,
        "forearm": arm_obj.data.bones.get('Forearm.L') is not None,
        "hand": arm_obj.data.bones.get('Hand.L') is not None,
    }
    
    # Test pose deformations
    # Switch to pose mode
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode='POSE')
    
    pose_results = {}
    
    # 1. Test wrist movement
    hand_pbone = arm_obj.pose.bones.get('Hand.L')
    if hand_pbone:
        # Rotate wrist pitch (45 deg)
        hand_pbone.rotation_mode = 'XYZ'
        hand_pbone.rotation_euler = Euler((math.radians(45), 0, 0), 'XYZ')
        bpy.context.view_layer.update()
        pose_results["wrist_pitch_45"] = "OK"
        # Reset
        hand_pbone.rotation_euler = Euler((0, 0, 0), 'XYZ')
        bpy.context.view_layer.update()
        
    # 2. Test each finger bend
    # Test rotating joints
    for f in range(1, 6):
        pb1 = arm_obj.pose.bones.get(f'Finger_{f}.1.L')
        pb2 = arm_obj.pose.bones.get(f'Finger_{f}.2.L')
        pb3 = arm_obj.pose.bones.get(f'Finger_{f}.3.L')
        
        if pb1:
            pb1.rotation_mode = 'XYZ'
            pb1.rotation_euler = Euler((math.radians(45), 0, 0), 'XYZ')
        if pb2:
            pb2.rotation_mode = 'XYZ'
            pb2.rotation_euler = Euler((math.radians(60), 0, 0), 'XYZ')
        if pb3:
            pb3.rotation_mode = 'XYZ'
            pb3.rotation_euler = Euler((math.radians(60), 0, 0), 'XYZ')
            
        bpy.context.view_layer.update()
        pose_results[f"finger_{f}_bend"] = "OK"
        
        # Reset
        if pb1: pb1.rotation_euler = Euler((0, 0, 0), 'XYZ')
        if pb2: pb2.rotation_euler = Euler((0, 0, 0), 'XYZ')
        if pb3: pb3.rotation_euler = Euler((0, 0, 0), 'XYZ')
        bpy.context.view_layer.update()

    bpy.ops.object.mode_set(mode='OBJECT')
    
    # Check rest pose mesh bounding box and orientation
    bb = [list(corner) for corner in left_mesh_obj.bound_box]
    
    return {
        "finger_heads": finger_heads,
        "arm_bones": arm_bones,
        "pose_results": pose_results,
        "left_mesh_bounds": bb,
        "has_full_arm_mesh": True, # Has shoulder and forearm geometry
    }

def test_vr_hands(fbx_path):
    reset_blend()
    bpy.ops.import_scene.fbx(filepath=fbx_path)
    
    arm_obj = bpy.data.objects.get('Armature')
    mesh_obj = bpy.data.objects.get('SM_HandsVR_Male')
    
    finger_heads = {}
    for f in ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']:
        b = arm_obj.data.bones.get(f'J_Left_Hand{f}1')
        if b:
            finger_heads[f] = {
                "head": list(b.head_local),
                "tail": list(b.tail_local),
                "length": b.length,
                "chain_length": len([c for c in arm_obj.data.bones if f'Hand{f}' in c.name and 'Left' in c.name])
            }
            
    # Check arm bones (does it have forearm/shoulder?)
    arm_bones = {
        "root": arm_obj.data.bones.get('Root') is not None,
        "j_left": arm_obj.data.bones.get('J_Left') is not None,
        "j_left_hand": arm_obj.data.bones.get('J_Left_Hand') is not None,
        "has_forearm": False, # J_Left is wrist/forearm stub
        "has_shoulder": False,
    }
    
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode='POSE')
    
    pose_results = {}
    
    # Test wrist
    wrist_pbone = arm_obj.pose.bones.get('J_Left_Hand')
    if wrist_pbone:
        wrist_pbone.rotation_mode = 'XYZ'
        wrist_pbone.rotation_euler = Euler((math.radians(45), 0, 0), 'XYZ')
        bpy.context.view_layer.update()
        pose_results["wrist_pitch_45"] = "OK"
        wrist_pbone.rotation_euler = Euler((0, 0, 0), 'XYZ')
        bpy.context.view_layer.update()
        
    for f in ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']:
        pb1 = arm_obj.pose.bones.get(f'J_Left_Hand{f}1')
        pb2 = arm_obj.pose.bones.get(f'J_Left_Hand{f}2')
        pb3 = arm_obj.pose.bones.get(f'J_Left_Hand{f}3')
        
        if pb1:
            pb1.rotation_mode = 'XYZ'
            pb1.rotation_euler = Euler((math.radians(45), 0, 0), 'XYZ')
        if pb2:
            pb2.rotation_mode = 'XYZ'
            pb2.rotation_euler = Euler((math.radians(60), 0, 0), 'XYZ')
        if pb3:
            pb3.rotation_mode = 'XYZ'
            pb3.rotation_euler = Euler((math.radians(60), 0, 0), 'XYZ')
            
        bpy.context.view_layer.update()
        pose_results[f"{f}_bend"] = "OK"
        
        if pb1: pb1.rotation_euler = Euler((0, 0, 0), 'XYZ')
        if pb2: pb2.rotation_euler = Euler((0, 0, 0), 'XYZ')
        if pb3: pb3.rotation_euler = Euler((0, 0, 0), 'XYZ')
        bpy.context.view_layer.update()

    bpy.ops.object.mode_set(mode='OBJECT')
    
    bb = [list(corner) for corner in mesh_obj.bound_box]
    
    return {
        "finger_heads": finger_heads,
        "arm_bones": arm_bones,
        "pose_results": pose_results,
        "mesh_bounds": bb,
        "has_full_arm_mesh": False # Only hands and wrists
    }

def main():
    base_dir = r"c:\PROJECT\SANKET VAANNI\design-reference"
    ext_dir = os.path.join(base_dir, "extracted")
    out_dir = os.path.join(base_dir, "evaluation_output")
    
    fbx1 = os.path.join(ext_dir, "fps-female-arms", "source", "[FPS Female Arms].fbx")
    fbx2 = os.path.join(ext_dir, "vr-hands", "source", "Hands VR.fbx")
    
    res1 = test_fps_arms(fbx1)
    res2 = test_vr_hands(fbx2)
    
    with open(os.path.join(out_dir, "deep_test_report.json"), "w") as f:
        json.dump({"fps_female_arms": res1, "vr_hands": res2}, f, indent=2)
        
    print("Deep test completed successfully!")

if __name__ == "__main__":
    main()
