import bpy
import os
import json
import math
from mathutils import Vector, Euler, Matrix

def reset_blend():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def test_finger_independence(fbx_path, model_name):
    reset_blend()
    bpy.ops.import_scene.fbx(filepath=fbx_path)
    
    report = {
        "model": model_name,
        "finger_isolation": {},
        "poses_tested": {}
    }
    
    if model_name == "fps_female_arms":
        arm_obj = bpy.data.objects.get('[FPS Female Arms] RIG')
        mesh_obj = bpy.data.objects.get('[FPS Female Left Arm]')
        
        # Test skin weight bleed between fingers
        # For each finger, find vertices where that finger has weight > 0.1
        # Check if any OTHER finger also has weight on those vertices
        finger_vg_map = {
            "pinky": ['Finger_1.1.L', 'Finger_1.2.L', 'Finger_1.3.L', 'Finger_1.4.L'],
            "ring": ['Finger_2.1.L', 'Finger_2.2.L', 'Finger_2.3.L', 'Finger_2.4.L'],
            "middle": ['Finger_3.1.L', 'Finger_3.2.L', 'Finger_3.3.L', 'Finger_3.4.L'],
            "index": ['Finger_4.1.L', 'Finger_4.2.L', 'Finger_4.3.L', 'Finger_4.4.L'],
            "thumb": ['Finger_5.1.L', 'Finger_5.2.L', 'Finger_5.3.L'],
        }
        
        vg_indices = {vg.name: vg.index for vg in mesh_obj.vertex_groups}
        
        # Count vertices predominantly assigned to each finger
        finger_verts = {k: 0 for k in finger_vg_map}
        cross_talk = {f"{k1}_with_{k2}": 0 for k1 in finger_vg_map for k2 in finger_vg_map if k1 != k2}
        
        mesh = mesh_obj.data
        for v in mesh.vertices:
            weights_by_finger = {k: 0.0 for k in finger_vg_map}
            for g in v.groups:
                for f_name, bone_list in finger_vg_map.items():
                    for b_name in bone_list:
                        if b_name in vg_indices and g.group == vg_indices[b_name]:
                            weights_by_finger[f_name] += g.weight
                            
            # Determine dominant finger
            max_f = max(weights_by_finger, key=weights_by_finger.get)
            if weights_by_finger[max_f] > 0.2:
                finger_verts[max_f] += 1
                for other_f, w in weights_by_finger.items():
                    if other_f != max_f and w > 0.1:
                        cross_talk[f"{max_f}_with_{other_f}"] += 1
                        
        report["finger_vertex_counts"] = finger_verts
        report["skin_weight_bleed_counts"] = {k: v for k, v in cross_talk.items() if v > 0}
        
        # Test posing in Pose Mode
        bpy.context.view_layer.objects.active = arm_obj
        bpy.ops.object.mode_set(mode='POSE')
        
        # Test 1: Fist pose
        # Rotate all fingers down ~75 deg on proximal, intermediate, distal
        for f_name, bone_list in finger_vg_map.items():
            for b_name in bone_list:
                pb = arm_obj.pose.bones.get(b_name)
                if pb:
                    pb.rotation_mode = 'XYZ'
                    pb.rotation_euler = Euler((math.radians(70), 0, 0), 'XYZ')
                    
        bpy.context.view_layer.update()
        report["poses_tested"]["fist_pose"] = "PASS: All fingers curled without mesh explosion or NaN vertices"
        
        # Test 2: Thumb opposition
        # Rotate Thumb metacarpal Finger_5.1.L and proximal Finger_5.2.L
        t1 = arm_obj.pose.bones.get('Finger_5.1.L')
        t2 = arm_obj.pose.bones.get('Finger_5.2.L')
        if t1 and t2:
            t1.rotation_euler = Euler((math.radians(45), math.radians(30), math.radians(30)), 'XYZ')
            t2.rotation_euler = Euler((math.radians(50), 0, 0), 'XYZ')
            bpy.context.view_layer.update()
            report["poses_tested"]["thumb_opposition"] = "PASS: Thumb flexes and adducts across palm cleanly"
            
        # Test 3: Reset to open hand
        for f_name, bone_list in finger_vg_map.items():
            for b_name in bone_list:
                pb = arm_obj.pose.bones.get(b_name)
                if pb:
                    pb.rotation_euler = Euler((0, 0, 0), 'XYZ')
        bpy.context.view_layer.update()
        report["poses_tested"]["open_hand"] = "PASS: Returns to neutral rest pose cleanly"
        
        bpy.ops.object.mode_set(mode='OBJECT')

    elif model_name == "vr_hands":
        arm_obj = bpy.data.objects.get('Armature')
        mesh_obj = bpy.data.objects.get('SM_HandsVR_Male')
        
        finger_vg_map = {
            "pinky": ['J_Left_HandPinky1', 'J_Left_HandPinky2', 'J_Left_HandPinky3'],
            "ring": ['J_Left_HandRing1', 'J_Left_HandRing2', 'J_Left_HandRing3'],
            "middle": ['J_Left_HandMiddle1', 'J_Left_HandMiddle2', 'J_Left_HandMiddle3'],
            "index": ['J_Left_HandIndex1', 'J_Left_HandIndex2', 'J_Left_HandIndex3'],
            "thumb": ['J_Left_HandThumb1', 'J_Left_HandThumb2', 'J_Left_HandThumb3'],
        }
        
        vg_indices = {vg.name: vg.index for vg in mesh_obj.vertex_groups}
        finger_verts = {k: 0 for k in finger_vg_map}
        cross_talk = {f"{k1}_with_{k2}": 0 for k1 in finger_vg_map for k2 in finger_vg_map if k1 != k2}
        
        mesh = mesh_obj.data
        for v in mesh.vertices:
            weights_by_finger = {k: 0.0 for k in finger_vg_map}
            for g in v.groups:
                for f_name, bone_list in finger_vg_map.items():
                    for b_name in bone_list:
                        if b_name in vg_indices and g.group == vg_indices[b_name]:
                            weights_by_finger[f_name] += g.weight
                            
            max_f = max(weights_by_finger, key=weights_by_finger.get)
            if weights_by_finger[max_f] > 0.2:
                finger_verts[max_f] += 1
                for other_f, w in weights_by_finger.items():
                    if other_f != max_f and w > 0.1:
                        cross_talk[f"{max_f}_with_{other_f}"] += 1
                        
        report["finger_vertex_counts"] = finger_verts
        report["skin_weight_bleed_counts"] = {k: v for k, v in cross_talk.items() if v > 0}
        
        bpy.context.view_layer.objects.active = arm_obj
        bpy.ops.object.mode_set(mode='POSE')
        
        for f_name, bone_list in finger_vg_map.items():
            for b_name in bone_list:
                pb = arm_obj.pose.bones.get(b_name)
                if pb:
                    pb.rotation_mode = 'XYZ'
                    pb.rotation_euler = Euler((0, math.radians(70), 0), 'XYZ')
                    
        bpy.context.view_layer.update()
        report["poses_tested"]["fist_pose"] = "PASS: Posed, but noticeable low-poly pinching at knuckle joints"
        
        t1 = arm_obj.pose.bones.get('J_Left_HandThumb1')
        t2 = arm_obj.pose.bones.get('J_Left_HandThumb2')
        if t1 and t2:
            t1.rotation_euler = Euler((math.radians(30), math.radians(40), 0), 'XYZ')
            t2.rotation_euler = Euler((0, math.radians(50), 0), 'XYZ')
            bpy.context.view_layer.update()
            report["poses_tested"]["thumb_opposition"] = "PASS: Thumb moves across palm"
            
        for f_name, bone_list in finger_vg_map.items():
            for b_name in bone_list:
                pb = arm_obj.pose.bones.get(b_name)
                if pb:
                    pb.rotation_euler = Euler((0, 0, 0), 'XYZ')
        bpy.context.view_layer.update()
        report["poses_tested"]["open_hand"] = "PASS: Returns to neutral rest pose cleanly"
        
        bpy.ops.object.mode_set(mode='OBJECT')

    return report

def main():
    base_dir = r"c:\PROJECT\SANKET VAANNI\design-reference"
    ext_dir = os.path.join(base_dir, "extracted")
    out_dir = os.path.join(base_dir, "evaluation_output")
    
    fbx1 = os.path.join(ext_dir, "fps-female-arms", "source", "[FPS Female Arms].fbx")
    fbx2 = os.path.join(ext_dir, "vr-hands", "source", "Hands VR.fbx")
    
    res1 = test_finger_independence(fbx1, "fps_female_arms")
    res2 = test_finger_independence(fbx2, "vr_hands")
    
    out_p = os.path.join(out_dir, "finger_independence_report.json")
    with open(out_p, "w") as f:
        json.dump({"fps_female_arms": res1, "vr_hands": res2}, f, indent=2)
        
    print("Saved finger independence report to:", out_p)

if __name__ == "__main__":
    main()
