import bpy
import os
import json
import math
from mathutils import Vector, Euler

bpy.ops.wm.read_factory_settings(use_empty=True)

fbx_path = r"c:\PROJECT\SANKET VAANNI\design-reference\extracted\vr-hands\source\Hands VR.fbx"
tex_path = r"c:\PROJECT\SANKET VAANNI\design-reference\extracted\vr-hands\textures\T_VRHands_Base_color.png"

bpy.ops.import_scene.fbx(filepath=fbx_path)

arm_obj = bpy.data.objects.get('Armature')
mesh_obj = bpy.data.objects.get('SM_HandsVR_Male')

info = {
    "armature_name": arm_obj.name,
    "mesh_name": mesh_obj.name,
    "vertex_count": len(mesh_obj.data.vertices),
    "polygon_count": len(mesh_obj.data.polygons),
    "bones": [b.name for b in arm_obj.data.bones],
    "materials": [m.name for m in mesh_obj.data.materials],
    "mesh_bounds": [list(c) for c in mesh_obj.bound_box]
}

# Inspect bone orientations and parent-child hierarchy
hierarchy = {}
for b in arm_obj.data.bones:
    hierarchy[b.name] = {
        "parent": b.parent.name if b.parent else None,
        "head": list(b.head_local),
        "tail": list(b.tail_local),
        "vector": list(b.tail_local - b.head_local)
    }
info["hierarchy"] = hierarchy

# Inspect vertex weights to separate left and right vertices
# In SM_HandsVR_Male, let's see which vertices belong to Left vs Right
left_bones = [b.name for b in arm_obj.data.bones if 'Left' in b.name]
right_bones = [b.name for b in arm_obj.data.bones if 'Right' in b.name]

# Check vertex group indices
vgroup_names = {vg.index: vg.name for vg in mesh_obj.vertex_groups}

left_verts = 0
right_verts = 0
for v in mesh_obj.data.vertices:
    has_left = any('Left' in vgroup_names.get(g.group, '') for g in v.groups if g.weight > 0.01)
    has_right = any('Right' in vgroup_names.get(g.group, '') for g in v.groups if g.weight > 0.01)
    if has_left and not has_right:
        left_verts += 1
    elif has_right and not has_left:
        right_verts += 1
info["left_verts"] = left_verts
info["right_verts"] = right_verts

# Test curling rotation in Pose mode for Left and Right hands
bpy.context.view_layer.objects.active = arm_obj
bpy.ops.object.mode_set(mode='POSE')

# Let's inspect bone roll / local axes
bone_axes = {}
for bone_name in ['J_Left_HandIndex1', 'J_Left_HandIndex2', 'J_Left_HandThumb1', 'J_Left_HandThumb2', 'J_Right_HandIndex1', 'J_Right_HandThumb1']:
    pb = arm_obj.pose.bones.get(bone_name)
    if pb:
        # local orientation
        mat = pb.bone.matrix_local
        bone_axes[bone_name] = {
            "matrix_local": [list(r) for r in mat]
        }
info["bone_axes"] = bone_axes

with open(r"c:\PROJECT\SANKET VAANNI\design-reference\evaluation_output\vr_bones_detail.json", "w") as f:
    json.dump(info, f, indent=2)

print("Bone inspection written successfully!")
