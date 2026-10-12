import bpy
import os
import json
from mathutils import Vector

bpy.ops.wm.read_factory_settings(use_empty=True)

fbx_vr = r"c:\PROJECT\SANKET VAANNI\design-reference\extracted\vr-hands\source\Hands VR.fbx"
bpy.ops.import_scene.fbx(filepath=fbx_vr)

arm_obj = bpy.data.objects.get('Armature')
mesh_obj = bpy.data.objects.get('SM_HandsVR_Male')

res = {}

for side in ['Left', 'Right']:
    prefix = f'J_{side}_Hand'
    w_bone = arm_obj.data.bones.get(prefix)
    t_bone = arm_obj.data.bones.get(f'{prefix}Thumb1')
    i_bone = arm_obj.data.bones.get(f'{prefix}Index1')
    p_bone = arm_obj.data.bones.get(f'{prefix}Pinky1')
    
    res[side] = {
        "wrist_head": list(w_bone.head_local) if w_bone else None,
        "thumb_head": list(t_bone.head_local) if t_bone else None,
        "index_head": list(i_bone.head_local) if i_bone else None,
        "pinky_head": list(p_bone.head_local) if p_bone else None,
    }

# Check normal direction of palm
# In mesh_obj, find faces assigned to Left vs Right
out_json = r"c:\PROJECT\SANKET VAANNI\design-reference\evaluation_output\anatomy_check.json"
with open(out_json, "w") as f:
    json.dump(res, f, indent=2)

print("Anatomy check written!")
