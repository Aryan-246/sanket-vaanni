import bpy
import os
import math
from mathutils import Vector, Euler

def reset_blend():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def setup_render_scene(arm_obj, mesh_obj, out_path, pose_type="rest", model_type="fps"):
    # Set camera and lights
    scene = bpy.context.scene
    scene.render.resolution_x = 800
    scene.render.resolution_y = 600
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = out_path
    
    # Remove existing cameras and lights
    for obj in list(bpy.data.objects):
        if obj.type in ('CAMERA', 'LIGHT'):
            bpy.data.objects.remove(obj)
            
    # Add Camera
    cam_data = bpy.data.cameras.new(name="RenderCam")
    cam_obj = bpy.data.objects.new(name="RenderCam", object_data=cam_data)
    bpy.context.collection.objects.link(cam_obj)
    scene.camera = cam_obj
    
    # Add Light
    light_data = bpy.data.lights.new(name="SunLight", type='SUN')
    light_data.energy = 3.5
    light_obj = bpy.data.objects.new(name="SunLight", object_data=light_data)
    bpy.context.collection.objects.link(light_obj)
    light_obj.rotation_euler = Euler((math.radians(45), math.radians(30), math.radians(60)), 'XYZ')
    
    # Fill light
    fill_data = bpy.data.lights.new(name="FillLight", type='SUN')
    fill_data.energy = 1.8
    fill_obj = bpy.data.objects.new(name="FillLight", object_data=fill_data)
    bpy.context.collection.objects.link(fill_obj)
    fill_obj.rotation_euler = Euler((math.radians(-45), math.radians(-30), 0), 'XYZ')
    
    if model_type == "fps":
        # Target the left hand
        hand_bone = arm_obj.data.bones.get('Hand.L')
        focus_pt = arm_obj.matrix_world @ hand_bone.head_local if hand_bone else Vector((-0.7, 0.2, 1.6))
        cam_obj.location = focus_pt + Vector((0.35, -0.45, 0.3))
        # Look at focus_pt
        direction = focus_pt - cam_obj.location
        rot_quat = direction.to_track_quat('-Z', 'Y')
        cam_obj.rotation_euler = rot_quat.to_euler()
        
        # Apply pose
        bpy.context.view_layer.objects.active = arm_obj
        bpy.ops.object.mode_set(mode='POSE')
        
        # Reset pose
        for pb in arm_obj.pose.bones:
            pb.rotation_euler = Euler((0,0,0), 'XYZ')
            
        if pose_type == "fist":
            # Bend all fingers
            for i in range(1, 6):
                for j in range(1, 5):
                    pb = arm_obj.pose.bones.get(f'Finger_{i}.{j}.L')
                    if pb:
                        pb.rotation_euler = Euler((math.radians(70), 0, 0), 'XYZ')
            t1 = arm_obj.pose.bones.get('Finger_5.1.L')
            if t1:
                t1.rotation_euler = Euler((math.radians(40), math.radians(35), 0), 'XYZ')
                
        elif pose_type == "thumbs_up":
            # Curl fingers 1-4, extend thumb 5
            for i in range(1, 5):
                for j in range(1, 5):
                    pb = arm_obj.pose.bones.get(f'Finger_{i}.{j}.L')
                    if pb:
                        pb.rotation_euler = Euler((math.radians(75), 0, 0), 'XYZ')
            t1 = arm_obj.pose.bones.get('Finger_5.1.L')
            t2 = arm_obj.pose.bones.get('Finger_5.2.L')
            if t1: t1.rotation_euler = Euler((math.radians(-20), math.radians(-30), 0), 'XYZ')
            if t2: t2.rotation_euler = Euler((math.radians(-15), 0, 0), 'XYZ')
            
        elif pose_type == "point":
            # Extend index (Finger 4), curl others (1, 2, 3, 5)
            for i in [1, 2, 3]:
                for j in range(1, 5):
                    pb = arm_obj.pose.bones.get(f'Finger_{i}.{j}.L')
                    if pb:
                        pb.rotation_euler = Euler((math.radians(75), 0, 0), 'XYZ')
            t1 = arm_obj.pose.bones.get('Finger_5.1.L')
            if t1: t1.rotation_euler = Euler((math.radians(40), math.radians(30), 0), 'XYZ')
            
        bpy.context.view_layer.update()
        bpy.ops.render.render(write_still=True)
        bpy.ops.object.mode_set(mode='OBJECT')

    elif model_type == "vr":
        hand_bone = arm_obj.data.bones.get('J_Left_Hand')
        focus_pt = arm_obj.matrix_world @ hand_bone.head_local if hand_bone else Vector((27, 2, 2))
        cam_obj.location = focus_pt + Vector((10, -25, 12))
        direction = focus_pt - cam_obj.location
        rot_quat = direction.to_track_quat('-Z', 'Y')
        cam_obj.rotation_euler = rot_quat.to_euler()
        
        bpy.context.view_layer.objects.active = arm_obj
        bpy.ops.object.mode_set(mode='POSE')
        for pb in arm_obj.pose.bones:
            pb.rotation_euler = Euler((0,0,0), 'XYZ')
            
        if pose_type == "fist":
            for f in ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']:
                for j in range(1, 4):
                    pb = arm_obj.pose.bones.get(f'J_Left_Hand{f}{j}')
                    if pb:
                        pb.rotation_euler = Euler((0, math.radians(70), 0), 'XYZ')
                        
        bpy.context.view_layer.update()
        bpy.ops.render.render(write_still=True)
        bpy.ops.object.mode_set(mode='OBJECT')

def main():
    base_dir = r"c:\PROJECT\SANKET VAANNI\design-reference"
    ext_dir = os.path.join(base_dir, "extracted")
    out_dir = os.path.join(base_dir, "evaluation_output")
    
    # 1. FPS model renders
    fbx_fps = os.path.join(ext_dir, "fps-female-arms", "source", "[FPS Female Arms].fbx")
    tex_fps = os.path.join(ext_dir, "fps-female-arms", "textures", "[FPS_Female_Arms]_[FPS_Female_Arms]_Materi.png")
    
    reset_blend()
    bpy.ops.import_scene.fbx(filepath=fbx_fps)
    arm_obj = bpy.data.objects.get('[FPS Female Arms] RIG')
    left_mesh = bpy.data.objects.get('[FPS Female Left Arm]')
    
    mat = bpy.data.materials.get('[FPS Female Arms] Material')
    if mat and mat.use_nodes:
        bsdf = mat.node_tree.nodes.get('Principled BSDF')
        tex_node = mat.node_tree.nodes.new('ShaderNodeTexImage')
        if os.path.exists(tex_fps):
            tex_node.image = bpy.data.images.load(tex_fps)
        if bsdf:
            mat.node_tree.links.new(tex_node.outputs['Color'], bsdf.inputs['Base Color'])
            
    setup_render_scene(arm_obj, left_mesh, os.path.join(out_dir, "render_fps_rest.png"), "rest", "fps")
    setup_render_scene(arm_obj, left_mesh, os.path.join(out_dir, "render_fps_fist.png"), "fist", "fps")
    setup_render_scene(arm_obj, left_mesh, os.path.join(out_dir, "render_fps_thumbs_up.png"), "thumbs_up", "fps")
    setup_render_scene(arm_obj, left_mesh, os.path.join(out_dir, "render_fps_point.png"), "point", "fps")
    
    # 2. VR model renders
    fbx_vr = os.path.join(ext_dir, "vr-hands", "source", "Hands VR.fbx")
    tex_vr = os.path.join(ext_dir, "vr-hands", "textures", "T_VRHands_Base_color.png")
    reset_blend()
    bpy.ops.import_scene.fbx(filepath=fbx_vr)
    vr_arm = bpy.data.objects.get('Armature')
    vr_mesh = bpy.data.objects.get('SM_HandsVR_Male')
    
    vr_mat = bpy.data.materials.get('VR_Hands_M')
    if vr_mat and vr_mat.use_nodes:
        bsdf = vr_mat.node_tree.nodes.get('Principled BSDF')
        tex_node = vr_mat.node_tree.nodes.new('ShaderNodeTexImage')
        if os.path.exists(tex_vr):
            tex_node.image = bpy.data.images.load(tex_vr)
        if bsdf:
            vr_mat.node_tree.links.new(tex_node.outputs['Color'], bsdf.inputs['Base Color'])
            
    setup_render_scene(vr_arm, vr_mesh, os.path.join(out_dir, "render_vr_rest.png"), "rest", "vr")
    setup_render_scene(vr_arm, vr_mesh, os.path.join(out_dir, "render_vr_fist.png"), "fist", "vr")
    
    print("All renders completed successfully!")

if __name__ == "__main__":
    main()
